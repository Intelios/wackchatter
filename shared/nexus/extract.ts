import type { TokenCounter } from '../prompt/token-cache.ts';
import { looseParseJson } from '../providers/looseJson.ts';
import type { ApiMessage, ChatMessage } from '../types/chat.ts';
import { memoryDocuments, searchDocuments } from './retrieve.ts';
import {
  evidenceFor,
  fingerprint,
  latest,
  messageFingerprint,
  nodeVersion,
  pendingMessages,
} from './state.ts';
import type {
  NexusEvidence,
  NexusNodeKind,
  NexusRevision,
  NexusSettings,
  NexusState,
} from './types.ts';

const CONTRACT = `Return only a JSON object: {"nodes":[],"records":[]}.
nodes: {"ref":"local-identifier-or-existing-node-id","name":"Joe","kind":"person|place|object|event","aliases":[],"sources":[0]}.
records: {"id":"existing-record-id ONLY when updating it; otherwise omit", "text":"one concise standalone memory", "kind":"fact|event|situation|thread", "assertion":"fact|claim|intention|event", "status":"active|resolved|historical|conflict", "nodeRefs":["local-identifier-or-existing-node-id"], "relation":{"from":"node-ref","to":"node-ref","label":"is from"}, "sources":[0], "cues":["hometown"], "conflicts":["existing-record-id"]}.
relation and conflicts are optional. Sources are the zero-based line numbers in this excerpt, required on every node and record. Multiple records may cite the same line. Use only evidence actually in the excerpt. Up to 48 nodes/records each; record text up to 2000 characters. An empty result is valid. Do not emit control fields, deletions, or changes to manually curated records.`;

interface WindowItem {
  message: ChatMessage;
  text: string;
  start: number;
  end: number;
}
export interface ExtractionBatch {
  messages: ApiMessage[];
  items: WindowItem[];
  progress: Record<string, string>;
  baseFingerprint: string;
}
interface ParsedNode {
  ref: string;
  name: string;
  kind: NexusNodeKind;
  aliases: string[];
  evidence: NexusEvidence[];
}
interface ParsedRecord {
  id?: string;
  revision: NexusRevision;
}
export interface ParsedExtraction {
  nodes: ParsedNode[];
  records: ParsedRecord[];
}

export function buildNexusExtraction(
  nexus: NexusState,
  messages: ChatMessage[],
  config: NexusSettings,
  counter: TokenCounter,
  profile: string,
): ExtractionBatch {
  const pending = pendingMessages(nexus, messages);
  if (!pending.length) throw new Error('No new messages need remembering.');
  const query = pending
    .slice(0, 3)
    .map((m) => m.mes)
    .join('\n')
    .slice(0, 3000);
  const relevant = searchDocuments(memoryDocuments(nexus, messages), query)
    .slice(0, 12)
    .map((r) => r.doc.recordId);
  const records = nexus.records
    .filter((r) => relevant.includes(r.id))
    .map((r) => ({ id: r.id, ...latest(r) }));
  const relevantNodes = new Set(records.flatMap((r) => r.nodeIds));
  const nodes = nexus.nodes
    .filter(
      (n) =>
        relevantNodes.has(n.id) || query.toLowerCase().includes(nodeVersion(n).name.toLowerCase()),
    )
    .slice(0, 24)
    .map((n) => ({ id: n.id, ...nodeVersion(n) }));
  const base: ApiMessage[] = [
    { role: 'system', content: `${config.extractPrompt}\n\n${CONTRACT}` },
    {
      role: 'system',
      content: `Profiles for interpretation, not evidence:\n${profile.slice(0, 3000)}\n\nExisting records (read-only context; preserve manual edits):\n${JSON.stringify({ nodes, records })}`,
    },
  ];
  const limit = config.inputTokens - config.outputTokens - 128;
  const items: WindowItem[] = [];
  const progress: Record<string, string> = {};
  const render = (lines: WindowItem[]) => [
    ...base,
    {
      role: 'user' as const,
      content: lines.map((x, i) => `[${i}] ${x.message.name}: ${x.text}`).join('\n'),
    },
  ];
  // Two preceding lines supply context without moving their checkpoints backwards.
  const first = messages.findIndex((m) => m.id === pending[0]!.id);
  for (const m of messages.slice(Math.max(0, first - 2), first).filter((m) => !m.is_system)) {
    const item = {
      message: m,
      text: m.mes.slice(-600),
      start: Math.max(0, m.mes.length - 600),
      end: m.mes.length,
    };
    if (counter.countChat(render([...items, item])) < limit / 2) items.push(item);
  }
  for (const m of pending.slice(0, 24)) {
    const hash = messageFingerprint(m);
    const saved = nexus.processed[m.id];
    const start = saved?.startsWith(`${hash}@`) ? Number(saved.slice(hash.length + 1)) || 0 : 0;
    let end = m.mes.length;
    let item = { message: m, text: m.mes.slice(start, end), start, end };
    if (counter.countChat(render([...items, item])) > limit) {
      if (Object.keys(progress).length) break;
      let lo = 0,
        hi = end - start;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = { ...item, text: m.mes.slice(start, start + mid) };
        if (counter.countChat(render([...items, candidate])) <= limit) lo = mid;
        else hi = mid - 1;
      }
      if (!lo)
        throw new Error(
          'Nexus instructions and existing context exceed the configured context limit. Increase the limit or shorten the extraction prompt.',
        );
      end = start + lo;
      item = { ...item, end, text: m.mes.slice(start, end) };
    }
    items.push(item);
    progress[m.id] = end === m.mes.length ? hash : `${hash}@${Math.max(start + 1, end - 100)}`;
    if (end < m.mes.length) break;
  }
  return {
    messages: render(items),
    items,
    progress,
    baseFingerprint: fingerprint(JSON.stringify(nexus)),
  };
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Nexus returned an invalid object.');
  return v as Record<string, unknown>;
};
const string = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new Error('Nexus returned missing or oversized text.');
  return v.trim();
};
function list(v: unknown, max = 24): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new Error('Nexus returned an invalid list.');
  return v;
}
function choice<T extends string>(v: unknown, choices: readonly T[]): T {
  if (!choices.includes(v as T))
    throw new Error(`Nexus returned an unsupported category: ${String(v)}`);
  return v as T;
}
function sources(v: unknown, batch: ExtractionBatch): NexusEvidence[] {
  const indices = list(v, 24);
  if (!indices.length) throw new Error('A memory is missing its source.');
  return [...new Set(indices)].map((i) => {
    if (typeof i !== 'number' || !Number.isInteger(i) || !batch.items[i])
      throw new Error('A memory cited a source outside its excerpt.');
    const item = batch.items[i]!;
    return { ...evidenceFor(item.message), excerpt: item.text.slice(0, 600) };
  });
}

export function parseExtraction(
  text: string,
  batch: ExtractionBatch,
  nexus: NexusState,
): ParsedExtraction {
  const raw = object(looseParseJson(text));
  const refs = new Set(nexus.nodes.map((n) => n.id));
  const nodes = list(raw.nodes, 48).map((v) => {
    const n = object(v);
    const ref = string(n.ref, 150);
    if (refs.has(ref) && !nexus.nodes.some((n) => n.id === ref))
      throw new Error('Duplicate node ref.');
    refs.add(ref);
    return {
      ref,
      name: string(n.name, 120),
      kind: choice(n.kind, ['person', 'place', 'object', 'event'] as const),
      aliases: list(n.aliases ?? [], 12).map((a) => string(a, 120)),
      evidence: sources(n.sources, batch),
    };
  });
  const resolve = (v: unknown) => {
    const id = string(v, 150);
    if (!refs.has(id)) throw new Error('A memory names an unknown node.');
    return id;
  };
  const records = list(raw.records, 48).map((v) => {
    const r = object(v);
    const id = r.id === undefined ? undefined : string(r.id, 150);
    if (id && !nexus.records.some((r) => r.id === id))
      throw new Error('A memory tries to update an unknown record.');
    const relation = r.relation === undefined ? undefined : object(r.relation);
    const evidence = sources(r.sources, batch);
    const conflicts = list(r.conflicts ?? [], 12).map((v) => string(v, 150));
    if (conflicts.some((id) => !nexus.records.some((r) => r.id === id)))
      throw new Error('Unknown conflicting record.');
    const revision: NexusRevision = {
      text: string(r.text, 2000),
      kind: choice(r.kind, ['fact', 'event', 'situation', 'thread'] as const),
      assertion: choice(r.assertion, ['fact', 'claim', 'intention', 'event'] as const),
      status: choice(r.status, ['active', 'resolved', 'historical', 'conflict'] as const),
      nodeIds: list(r.nodeRefs ?? [], 24).map(resolve),
      cues: list(r.cues ?? [], 12).map((c) => string(c, 100)),
      relation: relation
        ? {
            from: resolve(relation.from),
            to: resolve(relation.to),
            label: string(relation.label, 100),
          }
        : undefined,
      evidence,
      anchorId: batch.items.at(-1)?.message.id,
      created: Date.now(),
      enabled: true,
      pinned: false,
      deleted: false,
      manual: false,
      conflicts,
    };
    return { id, revision };
  });
  return { nodes, records };
}
export function applyExtraction(
  nexus: NexusState,
  parsed: ParsedExtraction,
  batch: ExtractionBatch,
  model: string,
): NexusState {
  if (fingerprint(JSON.stringify(nexus)) !== batch.baseFingerprint)
    throw new Error(
      'Nexus was edited while this batch was being read. Retry to use the updated records.',
    );
  const next = structuredClone(nexus);
  const ids = new Map(next.nodes.map((n) => [n.id, n.id]));
  for (const n of parsed.nodes) {
    const current = next.nodes.find((x) => x.id === n.ref);
    if (current) {
      if (!nodeVersion(current).manual)
        current.versions.push({
          name: n.name,
          kind: n.kind,
          aliases: n.aliases,
          evidence: n.evidence,
          anchorId: batch.items.at(-1)?.message.id,
          manual: false,
        });
    } else {
      const id = crypto.randomUUID();
      ids.set(n.ref, id);
      next.nodes.push({
        id,
        versions: [
          {
            name: n.name,
            kind: n.kind,
            aliases: n.aliases,
            evidence: n.evidence,
            anchorId: batch.items.at(-1)?.message.id,
            manual: false,
          },
        ],
      });
    }
  }
  for (const r of parsed.records) {
    const revision = {
      ...r.revision,
      model,
      nodeIds: r.revision.nodeIds.map((id) => ids.get(id)!),
      relation: r.revision.relation
        ? {
            ...r.revision.relation,
            from: ids.get(r.revision.relation.from)!,
            to: ids.get(r.revision.relation.to)!,
          }
        : undefined,
    };
    const textKey = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const current =
      next.records.find((x) => x.id === r.id) ??
      next.records.find((x) => x.revisions.some((v) => textKey(v.text) === textKey(revision.text)));
    if (current) {
      const top = latest(current);
      if (top.manual || top.deleted || !top.enabled) continue;
      current.revisions.push({ ...revision, pinned: top.pinned });
    } else {
      // A paraphrase of curated evidence is ambiguous. Keep it for review, never let it
      // silently undo a correction, disabling or deletion. Other sources stay independent.
      const protectedRecord = next.records.find((x) => {
        const top = latest(x);
        return (
          (top.manual || top.deleted || !top.enabled) &&
          top.kind === revision.kind &&
          top.evidence.length > 0 &&
          revision.evidence.every((e) =>
            top.evidence.some(
              (t) => t.messageId === e.messageId && t.fingerprint === e.fingerprint,
            ),
          ) &&
          top.nodeIds.length === revision.nodeIds.length &&
          top.nodeIds.every((id) => revision.nodeIds.includes(id))
        );
      });
      next.records.push({
        id: crypto.randomUUID(),
        revisions: [
          protectedRecord
            ? { ...revision, enabled: false, status: 'conflict', conflicts: [protectedRecord.id] }
            : revision,
        ],
      });
    }
  }
  next.processed = { ...next.processed, ...batch.progress };
  next.initialized = true;
  return next;
}
