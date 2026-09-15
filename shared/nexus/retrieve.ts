import type { ChatMessage } from '../types/chat.ts';
import {
  canonicalNode,
  evidenceFor,
  fingerprint,
  latest,
  liveRecords,
  supportedNodeVersion,
  textKey,
  validEvidence,
} from './state.ts';
import type {
  NexusDocument,
  NexusEmbedding,
  NexusFinding,
  NexusRecall,
  NexusState,
} from './types.ts';

const STOP = new Set(
  'a an the i you he she it we they me him her us them is are was were be been am do does did has have had to of for at in on with and or but that this these those what which who where when why how would could should can will my your his its our their as from about than then now said asks ask'.split(
    ' ',
  ),
);
export function terms(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((w) => !STOP.has(w) && w.length > 1)
        .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
    ),
  ];
}
export function memoryDocuments(
  nexus: NexusState,
  messages: readonly ChatMessage[],
): NexusDocument[] {
  const nodes = new Map(nexus.nodes.map((n) => [n.id, supportedNodeVersion(n, messages)]));
  return liveRecords(nexus, messages).flatMap(({ record, revision: current }) => {
    const history = latest(record).manual
      ? []
      : record.revisions.filter(
          (r) =>
            r !== current &&
            r.created <= current.created &&
            r.text !== current.text &&
            r.enabled &&
            !r.deleted &&
            r.evidence.length &&
            !r.needsReview &&
            validEvidence(r.evidence, messages),
        );
    return [
      ...history.map((revision) => ({ revision, historical: true })),
      { revision: current, historical: false },
    ].map(({ revision, historical }) => {
      const nodeIds = [...new Set(revision.nodeIds.map((id) => canonicalNode(nexus, id)))];
      const names = nodeIds.flatMap((id) => {
        const n = nodes.get(id);
        return n && !n.deleted ? [n.name, ...n.aliases] : [];
      });
      const relation = revision.relation ? [revision.relation.label] : [];
      const text = `${historical || revision.status === 'historical' ? '[Earlier] ' : revision.status === 'resolved' ? '[Resolved] ' : revision.status === 'conflict' ? '[Conflicting account] ' : ''}${revision.legacy ? '[Legacy event] ' : ''}${revision.assertion === 'claim' ? '[Reported claim] ' : revision.assertion === 'intention' ? '[Intention] ' : ''}${revision.text}`;
      const cues = [...revision.cues, ...names, ...relation];
      return {
        id: historical
          ? `record:${record.id}:history:${fingerprint(JSON.stringify(revision))}`
          : `record:${record.id}`,
        historical,
        recordId: record.id,
        text,
        nodeIds,
        cues,
        evidence: revision.evidence,
        fingerprint: fingerprint(JSON.stringify([text, cues])),
      };
    });
  });
}
export function transcriptDocuments(messages: readonly ChatMessage[]): NexusDocument[] {
  return messages
    .filter((m) => !m.is_system && m.mes.trim())
    .flatMap((m) => {
      const docs: NexusDocument[] = [];
      // Overlap preserves a fact across boundaries; inference additionally checks the real tokenizer limit.
      for (let start = 0; start < m.mes.length; start += 680) {
        const text = `${m.name}: ${m.mes.slice(start, start + 800)}`;
        docs.push({
          id: `message:${m.id}:${start}`,
          text,
          fingerprint: fingerprint(text),
          nodeIds: [],
          cues: [],
          evidence: [{ ...evidenceFor(m), excerpt: m.mes.slice(start, start + 800) }],
        });
        if (start + 800 >= m.mes.length) break;
      }
      return docs;
    });
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function searchDocuments(
  documents: NexusDocument[],
  query: string,
  embeddings: readonly NexusEmbedding[] = [],
  queryVector?: readonly number[],
) {
  const queryTerms = terms(query.split('\nRecent context:')[0]!);
  const tokenized = documents.map((d) => terms(`${d.text} ${d.cues.join(' ')}`));
  const freq = new Map<string, number>();
  for (const tokens of tokenized) for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const vectors = new Map(embeddings.map((e) => [e.documentId, e]));
  const scored = documents.map((doc, i) => {
    const matched = queryTerms.filter(
      (t) =>
        tokenized[i]!.includes(t) &&
        (documents.length < 6 || (freq.get(t) ?? 0) / documents.length < 0.4),
    );
    const lexical =
      matched.reduce(
        (sum, t) =>
          sum +
          Math.log(1 + (documents.length - (freq.get(t) ?? 0) + 0.5) / ((freq.get(t) ?? 0) + 0.5)),
        0,
      ) / Math.sqrt(Math.max(1, tokenized[i]!.length / 15));
    const vector = vectors.get(doc.id);
    const semantic =
      queryVector && vector?.fingerprint === doc.fingerprint
        ? cosine(queryVector, vector.vector)
        : 0;
    return { doc, lexical, semantic, matched, score: 0, reasons: [] as string[] };
  });
  const lex = [...scored]
    .filter((s) => s.lexical > 0)
    .sort((a, b) => b.lexical - a.lexical || a.doc.id.localeCompare(b.doc.id))
    .slice(0, 24);
  const sem = [...scored]
    .filter((s) => s.semantic >= 0.5)
    .sort((a, b) => b.semantic - a.semantic || a.doc.id.localeCompare(b.doc.id))
    .slice(0, 24);
  for (const [i, s] of lex.entries()) {
    s.score += 1 / (10 + i + 1);
    s.reasons.push(`Text match: ${s.matched.slice(0, 4).join(', ')}`);
  }
  for (const [i, s] of sem.entries()) {
    s.score += 1.25 / (10 + i + 1);
    s.reasons.push('Semantic match');
  }
  return scored
    .filter((s) => s.score > 0)
    .sort(
      (a, b) => b.score - a.score || b.semantic - a.semantic || a.doc.id.localeCompare(b.doc.id),
    );
}
export function recallQuery(
  messages: readonly ChatMessage[],
  draft = '',
  names: readonly string[] = [],
): string {
  const recent = messages.filter((m) => !m.is_system && m.mes.trim()).slice(-2);
  const focus = draft.trim() || recent.at(-1)?.mes || '';
  // An explicit subject makes unrelated recent turns noise. Pronouns still need local context.
  if (
    names.some((name) => terms(focus).includes(name.toLowerCase())) &&
    !/\b(he|she|her|his|they|them|it|there|that|our|we)\b/i.test(focus)
  )
    return focus;
  const context = recent
    .slice(draft.trim() ? -2 : -3, draft.trim() ? undefined : -1)
    .map((m) => `${m.name}: ${m.mes.slice(-350)}`)
    .join('\n');
  return context ? `${focus}\nRecent context: ${context}` : focus;
}
export function retrieveNexus(options: {
  nexus: NexusState;
  messages: readonly ChatMessage[];
  query: string;
  budget: number;
  countTokens: (text: string) => number;
  embeddings?: readonly NexusEmbedding[];
  queryVector?: readonly number[];
  findings?: readonly NexusFinding[];
  label?: NexusRecall['label'];
}): NexusRecall {
  const { nexus, messages, query, countTokens } = options;
  const docs = memoryDocuments(nexus, messages);
  const live = new Map(liveRecords(nexus, messages).map((v) => [v.record.id, v.revision]));
  const ranked = searchDocuments(docs, query, options.embeddings, options.queryVector);
  const candidates = new Map(ranked.slice(0, 3).map((r) => [r.doc.id, r]));
  // Expand only the strongest matches, and only a bounded number of neighbours. A protagonist is not a wildcard.
  const degree = new Map<string, number>();
  for (const doc of docs) for (const id of doc.nodeIds) degree.set(id, (degree.get(id) ?? 0) + 1);
  const seeds = new Set(
    ranked
      .slice(0, 2)
      .flatMap((r) => r.doc.nodeIds)
      .filter((id) => (degree.get(id) ?? 0) <= 3),
  );
  const neighbours = docs
    .filter((d) => !candidates.has(d.id) && d.nodeIds.some((id) => seeds.has(id)))
    .slice(-2);
  for (const doc of neighbours)
    candidates.set(doc.id, {
      doc,
      lexical: 0,
      semantic: 0,
      matched: [],
      score: 0.003,
      reasons: ['Connected memory'],
    });
  for (const doc of docs) {
    const r = live.get(doc.recordId!);
    if (!doc.historical && (r?.pinned || (r?.kind === 'situation' && r.status === 'active'))) {
      const current = candidates.get(doc.id) ?? {
        doc,
        lexical: 0,
        semantic: 0,
        matched: [],
        score: 0,
        reasons: [],
      };
      current.score += r.pinned ? 3 : 2;
      current.reasons.unshift(r.pinned ? 'Pinned' : 'Current situation');
      candidates.set(doc.id, current);
    }
  }
  for (const f of options.findings ?? [])
    if (f.selected && validEvidence(f.evidence, messages)) {
      const doc: NexusDocument = { ...f, fingerprint: fingerprint(f.text), cues: [] };
      candidates.set(doc.id, {
        doc,
        score: 4,
        lexical: 0,
        semantic: 0,
        matched: [],
        reasons: ['Selected for this request'],
      });
    }
  const selected = [...candidates.values()].sort(
    (a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id),
  );
  const used = new Set<string>();
  const included: typeof selected = [];
  const hits = selected.map(({ doc, score, reasons }) => {
    const cost = countTokens(`• ${doc.text}\n`);
    const totalCost = countTokens(
      [...included.map((r) => `• ${r.doc.text}`), `• ${doc.text}`].join('\n'),
    );
    const key = textKey(doc.text);
    const fits = !used.has(key) && totalCost <= Math.max(0, options.budget);
    if (fits) {
      used.add(key);
      included.push(candidates.get(doc.id)!);
    }
    return {
      ...doc,
      score,
      reasons: [
        ...reasons,
        ...(!fits ? [used.has(key) ? 'Duplicate' : 'Outside token budget'] : []),
      ],
      tokens: cost,
      included: fits,
    };
  });
  included.sort(
    (a, b) =>
      (live.get(a.doc.recordId ?? '')?.created ?? Number.MAX_SAFE_INTEGER) -
      (live.get(b.doc.recordId ?? '')?.created ?? Number.MAX_SAFE_INTEGER),
  );
  return {
    text: included.map((r) => `• ${r.doc.text}`).join('\n'),
    hits,
    tokens: countTokens(included.map((r) => `• ${r.doc.text}`).join('\n')),
    semantic: Boolean(options.queryVector),
    label: options.label ?? 'Preview',
  };
}
