import type { ChatMessage, Memory } from '../types/chat.ts';
import type { NexusEvidence, NexusNode, NexusRecord, NexusRevision, NexusState } from './types.ts';

/** Two independent 32-bit hashes: synchronous in the reducer, stable across environments. */
export function fingerprint(text: string): string {
  let a = 2166136261;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}:${text.length}`;
}
export function messageFingerprint(message: ChatMessage): string {
  return fingerprint(
    JSON.stringify([message.name, message.is_user, message.persona_id, message.mes]),
  );
}
export const emptyNexus = (): NexusState => ({
  version: 1,
  nodes: [],
  records: [],
  processed: {},
  initialized: false,
  paused: false,
});
export function evidenceFor(message: ChatMessage): NexusEvidence {
  return {
    messageId: message.id,
    fingerprint: messageFingerprint(message),
    excerpt: message.mes.slice(0, 600),
  };
}
const nodeIndexes = new WeakMap<NexusState, Map<string, NexusNode>>();
function nodeIndex(nexus: NexusState) {
  let index = nodeIndexes.get(nexus);
  if (!index) {
    index = new Map(nexus.nodes.map((n) => [n.id, n]));
    nodeIndexes.set(nexus, index);
  }
  return index;
}
const evidenceIndexes = new WeakMap<
  readonly ChatMessage[],
  Map<string, { fingerprint: string; hidden: boolean; owner?: string }>
>();
/** Messages are immutable projections; build the version index once per projection. */
export function evidenceValidator(messages: readonly ChatMessage[]) {
  let index = evidenceIndexes.get(messages);
  if (!index) {
    index = new Map(
      messages.map((m) => [
        m.id,
        { fingerprint: messageFingerprint(m), hidden: m.is_system, owner: m.hiddenBy },
      ]),
    );
    evidenceIndexes.set(messages, index);
  }
  const byId = index;
  return (evidence: readonly NexusEvidence[]) =>
    evidence.every((e) => {
      const m = byId.get(e.messageId);
      return Boolean(
        m &&
          (!m.hidden || (e.legacyHiddenBy && m.owner === e.legacyHiddenBy)) &&
          m.fingerprint === e.fingerprint,
      );
    });
}
export function validEvidence(
  evidence: readonly NexusEvidence[],
  messages: readonly ChatMessage[],
): boolean {
  return evidenceValidator(messages)(evidence);
}
export function supportedNodeVersion(node: NexusNode, messages: readonly ChatMessage[]) {
  const valid = evidenceValidator(messages);
  const ids = evidenceIndexes.get(messages)!;
  const top = nodeVersion(node);
  const usable = (v: ReturnType<typeof nodeVersion>) =>
    (!v.anchorId || ids.has(v.anchorId)) && valid(v.evidence);
  return top.manual ? (usable(top) ? top : undefined) : node.versions.findLast(usable);
}
export function nodeVersion(node: NexusNode) {
  return node.versions.at(-1)!;
}
export function latest(record: NexusRecord): NexusRevision {
  return record.revisions.at(-1)!;
}
export function canonicalNode(nexus: NexusState, id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const node = nodeIndex(nexus).get(current);
    const target = node && nodeVersion(node).mergedInto;
    if (!target) break;
    current = target;
  }
  return current;
}
export function liveRecords(
  nexus: NexusState,
  messages: readonly ChatMessage[],
): { record: NexusRecord; revision: NexusRevision }[] {
  const ids = new Set(messages.map((m) => m.id));
  return nexus.records.flatMap((record) => {
    const top = latest(record);
    if (!top || top.deleted || !top.enabled) return [];
    const checkEvidence = evidenceValidator(messages);
    const valid = (r: NexusRevision) =>
      (!r.anchorId || ids.has(r.anchorId)) &&
      Boolean(r.text.trim()) &&
      !r.needsReview &&
      (r.manual || r.legacy || r.evidence.length > 0) &&
      checkEvidence(r.evidence);
    const revision = top.manual ? (valid(top) ? top : undefined) : record.revisions.findLast(valid);
    if (!revision || revision.deleted || !revision.enabled) return [];
    return [{ record, revision }];
  });
}
export function reviseRecord(
  nexus: NexusState,
  id: string,
  patch: Partial<NexusRevision>,
  anchorId?: string,
): NexusState {
  return {
    ...nexus,
    records: nexus.records.map((r) =>
      r.id === id
        ? {
            ...r,
            revisions: [
              ...r.revisions,
              {
                ...latest(r),
                ...patch,
                ...(patch.nodeIds &&
                latest(r).relation &&
                (!patch.nodeIds.includes(latest(r).relation!.from) ||
                  !patch.nodeIds.includes(latest(r).relation!.to))
                  ? { relation: undefined }
                  : {}),
                anchorId,
                manual: true,
                created: Date.now(),
              },
            ],
          }
        : r,
    ),
  };
}
export function reviseNode(
  nexus: NexusState,
  id: string,
  patch: Partial<ReturnType<typeof nodeVersion>>,
  anchorId?: string,
): NexusState {
  return {
    ...nexus,
    nodes: nexus.nodes.map((n) =>
      n.id === id
        ? {
            ...n,
            versions: [...n.versions, { ...nodeVersion(n), ...patch, anchorId, manual: true }],
          }
        : n,
    ),
  };
}
export function mergeNodes(
  nexus: NexusState,
  from: string,
  to: string,
  anchorId?: string,
): NexusState {
  if (from === to || canonicalNode(nexus, to) === from) return nexus;
  const source = nexus.nodes.find((n) => n.id === from);
  const target = nexus.nodes.find((n) => n.id === to);
  if (!source || !target) return nexus;
  const merged = reviseNode(nexus, from, { mergedInto: to }, anchorId);
  return reviseNode(
    merged,
    to,
    {
      aliases: [
        ...new Set([
          ...nodeVersion(target).aliases,
          nodeVersion(source).name,
          ...nodeVersion(source).aliases,
        ]),
      ],
    },
    anchorId,
  );
}
export function pendingMessages(
  nexus: NexusState,
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return messages.filter(
    (m) => !m.is_system && m.mes.trim() && nexus.processed[m.id] !== messageFingerprint(m),
  );
}
export function branchNexus(nexus: NexusState, idMap: Map<string, string>): NexusState {
  const canCopy = (v: { anchorId?: string; evidence: NexusEvidence[] }) =>
    (!v.anchorId || idMap.has(v.anchorId)) && v.evidence.every((e) => idMap.has(e.messageId));
  const remap = <T extends { anchorId?: string; evidence: NexusEvidence[] }>(v: T): T => ({
    ...v,
    anchorId: v.anchorId ? idMap.get(v.anchorId) : undefined,
    evidence: v.evidence.map((e) => ({ ...e, messageId: idMap.get(e.messageId)! })),
  });
  const nodes = nexus.nodes.flatMap((n) => {
    const versions = n.versions.filter(canCopy).map(remap);
    return versions.length ? [{ ...n, versions }] : [];
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const records = nexus.records.flatMap((r) => {
    const revisions = r.revisions.filter(canCopy).map((v) =>
      remap({
        ...v,
        nodeIds: v.nodeIds.filter((id) => nodeIds.has(id)),
        relation:
          v.relation && nodeIds.has(v.relation.from) && nodeIds.has(v.relation.to)
            ? v.relation
            : undefined,
      }),
    );
    return revisions.length ? [{ ...r, revisions }] : [];
  });
  return {
    ...nexus,
    nodes,
    records,
    processed: Object.fromEntries(
      Object.entries(nexus.processed)
        .filter(([id]) => idMap.has(id))
        .map(([id, hash]) => [idMap.get(id)!, hash]),
    ),
  };
}
export function migrateMemories(memories: Memory[], messages: ChatMessage[]): NexusState {
  const nexus = emptyNexus();
  for (const m of memories) {
    const start = messages.findIndex((x) => x.id === m.range?.startId);
    const end = messages.findIndex((x) => x.id === m.range?.endId);
    const covered = start >= 0 && end >= start ? messages.slice(start, end + 1) : [];
    const evidence = covered.map((x) => ({
      ...evidenceFor(x),
      ...(x.hiddenBy === m.id ? { legacyHiddenBy: m.id } : {}),
    }));
    const anchorId = m.range?.endId ?? messages.at(-1)?.id;
    const nodeId = `legacy:${m.id}`;
    nexus.nodes.push({
      id: nodeId,
      versions: [
        {
          name: m.title,
          aliases: [],
          kind: 'event',
          evidence,
          anchorId,
          manual: m.edited || m.source === 'manual',
        },
      ],
    });
    nexus.records.push({
      id: m.id,
      revisions: [
        {
          text: [m.text, ...(m.quotes ?? []).map((q) => `“${q}”`)].join('\n'),
          kind: 'event',
          assertion: 'event',
          status: 'active',
          nodeIds: [nodeId],
          cues: m.keywords,
          evidence,
          anchorId,
          created: m.generatedAt,
          enabled: m.enabled,
          needsReview: Boolean(m.stale) || undefined,
          pinned: m.pinned,
          manual: m.edited || m.source === 'manual',
          deleted: false,
          legacy: true,
          model: m.model,
        },
      ],
    });
  }
  return nexus;
}
