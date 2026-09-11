import { describe, expect, test } from 'bun:test';
import { filterRecallFindings, NEAR_DUPLICATE_COSINE, recallSearchMessages } from './findings.ts';
import type { NexusDocument, NexusEmbedding, NexusRecord } from './types.ts';

const doc = (id: string, text: string, recordId?: string): NexusDocument => ({
  id,
  text,
  fingerprint: `fp:${id}`,
  nodeIds: [],
  cues: [],
  evidence: [],
  ...(recordId ? { recordId } : {}),
});
const embedding = (id: string, fingerprint: string, vector: number[]): NexusEmbedding => ({
  documentId: id,
  fingerprint,
  vector,
});
const vectorMap = (entries: NexusEmbedding[]) => new Map(entries.map((e) => [e.documentId, e]));
const record = (id: string, texts: string[]): NexusRecord => ({
  id,
  revisions: texts.map((text, i) => ({
    text,
    kind: 'fact',
    assertion: 'fact',
    status: 'active',
    nodeIds: [],
    evidence: [],
    created: i,
    enabled: true,
    pinned: false,
    deleted: false,
    manual: false,
    cues: [],
  })),
});

describe('recall search prompt', () => {
  test('numbers sources and keeps the JSON contract', () => {
    const messages = recallSearchMessages('Where is Joe from?', [doc('a', 'A'), doc('b', 'B')], []);
    expect(messages[0]!.content).toContain('Reply ONLY with JSON');
    expect(messages[1]!.content).toBe('Question: Where is Joe from?\n\n[0] A\n\n[1] B');
  });
  test('lists what the automatic selection already loaded', () => {
    const messages = recallSearchMessages('Q', [doc('a', 'Source')], ['Joe lives in London.']);
    expect(messages[1]!.content).toContain(
      'Already recalled into the next request — do not restate these:',
    );
    expect(messages[1]!.content).toContain('- Joe lives in London.');
    expect(messages[1]!.content).toContain('[0] Source');
  });
});

describe('filterRecallFindings', () => {
  const included = record('watch', ['Joe repairs antique watches for a living.']);
  const embeddings = new Map<string, NexusEmbedding>();

  test('drops a finding that only cites already-loaded records', () => {
    const { kept, dropped } = filterRecallFindings({
      findings: [{ text: 'Watch fact', docs: [doc('record:watch', 'record text', 'watch')] }],
      includedRecords: [included],
      embeddings,
    });
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });
  test('keeps a finding citing an already-loaded record plus a transcript passage', () => {
    const { kept } = filterRecallFindings({
      findings: [
        {
          text: 'New fact',
          docs: [doc('record:watch', 'record text', 'watch'), doc('message:m:0', 'passage')],
        },
      ],
      includedRecords: [included],
      embeddings,
    });
    expect(kept).toHaveLength(1);
  });
  test('drops phrasing matches of a loaded record, case and whitespace insensitive', () => {
    const { kept, dropped } = filterRecallFindings({
      findings: [
        { text: 'Joe  REPAIRS antique watches for a living.', docs: [doc('message:m:0', 'p')] },
      ],
      includedRecords: [included],
      embeddings,
    });
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });
  test('keeps a text match against a record the selection did not load', () => {
    const { kept } = filterRecallFindings({
      findings: [
        { text: 'Joe said he grew up in London.', docs: [doc('record:home', 't', 'home')] },
      ],
      includedRecords: [included],
      embeddings,
    });
    expect(kept).toHaveLength(1);
  });
  test('drops a later finding duplicating an earlier one', () => {
    const { kept, dropped } = filterRecallFindings({
      findings: [
        { text: 'Joe was seen at the docks.', docs: [doc('message:a:0', 'a')] },
        { text: 'Joe was seen at the  docks.', docs: [doc('message:b:0', 'b')] },
      ],
      includedRecords: [included],
      embeddings,
    });
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(1);
  });
  test('drops a transcript passage near-duplicating a loaded record, skips without vectors', () => {
    const vectors = vectorMap([
      embedding('message:m:0', 'fp:message:m:0', [1, 0]),
      embedding('record:watch', 'stale-anyway', [1, 0]),
      embedding('message:m:1', 'fp:message:m:1', [0, 1]),
    ]);
    const findings = [
      { text: 'Same fact as the record.', docs: [doc('message:m:0', 'aligned passage')] },
      { text: 'A different fact.', docs: [doc('message:m:1', 'orthogonal passage')] },
      { text: 'No vector cached.', docs: [doc('message:m:2', 'unindexed passage')] },
    ];
    const { kept, dropped } = filterRecallFindings({
      findings,
      includedRecords: [included],
      embeddings: vectors,
    });
    expect(kept.map((f) => f.text)).toEqual(['A different fact.', 'No vector cached.']);
    expect(dropped).toBe(1);
    // A stale passage vector (fingerprint mismatch) cannot witness anything.
    const stale = vectorMap([
      embedding('message:m:0', 'old', [1, 0]),
      embedding('record:watch', 'r', [1, 0]),
    ]);
    expect(
      filterRecallFindings({
        findings: [findings[0]!],
        includedRecords: [included],
        embeddings: stale,
      }).kept,
    ).toHaveLength(1);
  });
  test('the semantic threshold separates a retold fact from a different one', () => {
    const vectors = vectorMap([
      embedding('record:watch', 'fp:record:watch', [1, 0]),
      embedding('message:same:0', 'fp:message:same:0', [1, 0.05]),
      embedding('message:other:0', 'fp:message:other:0', [1, 1]),
    ]);
    const cosine = (a: number[], b: number[]) =>
      (a[0]! * b[0]! + a[1]! * b[1]!) / (Math.hypot(...a) * Math.hypot(...b));
    expect(cosine([1, 0], [1, 0.05])).toBeGreaterThanOrEqual(NEAR_DUPLICATE_COSINE);
    expect(cosine([1, 0], [1, 1])).toBeLessThan(NEAR_DUPLICATE_COSINE);
    const { kept } = filterRecallFindings({
      findings: [
        { text: 'Retold.', docs: [doc('message:same:0', 'x')] },
        { text: 'Different.', docs: [doc('message:other:0', 'y')] },
      ],
      includedRecords: [included],
      embeddings: vectors,
    });
    expect(kept.map((f) => f.text)).toEqual(['Different.']);
  });
});
