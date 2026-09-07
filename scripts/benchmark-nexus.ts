import { env, type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers';
import { encode } from 'gpt-tokenizer';
import { recallMemories } from '../shared/memory/source.ts';
import { RETRIEVAL_QUERIES, STORY_FACTS } from '../shared/nexus/fixture.ts';
import { memoryDocuments, retrieveNexus } from '../shared/nexus/retrieve.ts';
import { emptyNexus, evidenceFor } from '../shared/nexus/state.ts';
import type { NexusEmbedding, NexusNodeKind } from '../shared/nexus/types.ts';
import { DEFAULT_WI_SETTINGS } from '../shared/types/worldinfo.ts';
import { encodeText } from '../src/features/nexus/embeddingModel.ts';

env.allowRemoteModels = false;
env.localModelPath = new URL('../public/models/', import.meta.url).pathname;
const createPipeline = pipeline as unknown as (
  task: string,
  name: string,
  options: object,
) => Promise<FeatureExtractionPipeline>;
const before = performance.now();
const pipe = await createPipeline('feature-extraction', 'bge-small-en-v1.5', { dtype: 'q8' });
const coldMs = performance.now() - before;
const nexus = emptyNexus();
const messages = STORY_FACTS.map(([id, mes]) => ({
  id,
  mes,
  name: 'Narrator',
  is_user: false,
  is_system: false,
  send_date: '',
}));
for (const [i, [id, text, names, cues]] of STORY_FACTS.entries()) {
  const nodeIds: string[] = [];
  for (const name of names) {
    let node = nexus.nodes.find((n) => n.versions[0]!.name === name);
    if (!node) {
      node = {
        id: name,
        versions: [
          {
            name,
            aliases: [],
            kind: (['Joe', 'Anna', 'Mary'].includes(name) ? 'person' : 'place') as NexusNodeKind,
            evidence: [evidenceFor(messages[i]!)],
            manual: false,
          },
        ],
      };
      nexus.nodes.push(node);
    }
    nodeIds.push(node.id);
  }
  nexus.records.push({
    id,
    revisions: [
      {
        text,
        kind: 'fact',
        assertion: 'fact',
        status: 'active',
        nodeIds,
        cues: [...cues],
        evidence: [evidenceFor(messages[i]!)],
        anchorId: messages[i]!.id,
        created: i,
        enabled: true,
        pinned: false,
        deleted: false,
        manual: false,
      },
    ],
  });
}
const docs = memoryDocuments(nexus, messages);
const embeddings: NexusEmbedding[] = [];
for (const doc of docs)
  embeddings.push({
    documentId: doc.id,
    fingerprint: doc.fingerprint,
    vector: await encodeText(pipe, doc.text),
  });
const countTokens = (text: string) => encode(text).length;
const results = [];
for (const q of RETRIEVAL_QUERIES) {
  const start = performance.now();
  const vector = await encodeText(pipe, q.query, true);
  const base = { nexus, messages, query: q.query, budget: 1200, countTokens };
  const hybrid = retrieveNexus({ ...base, embeddings, queryVector: vector });
  const textGraph = retrieveNexus(base);
  const memories = STORY_FACTS.map(([id, text, names, cues]) => ({
    id,
    title: id,
    text,
    keywords: [...names, ...cues],
    source: 'generated' as const,
    edited: false,
    pinned: false,
    enabled: true,
    generatedAt: 0,
  }));
  const baseline = recallMemories({
    memories,
    messages: [
      { id: 'query', name: '', is_user: true, is_system: false, mes: q.query, send_date: '' },
    ],
    settings: DEFAULT_WI_SETTINGS,
    budget: 1200,
    countTokens,
  });
  results.push({
    ...q,
    keyword: baseline?.recalled.map((r) => r.id) ?? [],
    textGraph: textGraph.hits.filter((h) => h.included).map((h) => h.recordId!),
    hybrid: hybrid.hits.filter((h) => h.included).map((h) => h.recordId!),
    tokens: {
      keyword: countTokens(baseline?.text ?? ''),
      textGraph: textGraph.tokens,
      hybrid: hybrid.tokens,
    },
    milliseconds: Math.round(performance.now() - start),
  });
}
const metrics = (split: string, key: 'keyword' | 'textGraph' | 'hybrid') => {
  const cases = results.filter((r) => r.split === split && r.expected);
  return {
    correct: cases.filter((r) => r[key].includes(r.expected!)).length,
    total: cases.length,
    meanIrrelevant:
      cases.reduce((s, r) => s + r[key].filter((id) => id !== r.expected).length, 0) / cases.length,
    meanTokens: cases.reduce((s, r) => s + r.tokens[key], 0) / cases.length,
  };
};
const report = {
  note: 'Frozen synthetic English fixture. Full shared retrieval pipeline, same 1200-token ceiling; native CPU timings are not browser timings. Held-out queries were fixed before tuning.',
  coldMs: Math.round(coldMs),
  rssMB: Math.round(process.memoryUsage().rss / 1e6),
  metrics: Object.fromEntries(
    ['development', 'held-out'].map((split) => [
      split,
      Object.fromEntries(
        ['keyword', 'textGraph', 'hybrid'].map((key) => [key, metrics(split, key as 'keyword')]),
      ),
    ]),
  ),
  results,
};
await Bun.write(
  new URL('../shared/nexus/benchmark-results.json', import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
await pipe.dispose();
