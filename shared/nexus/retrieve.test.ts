import { expect, test } from 'bun:test';
import {
  memoryDocuments,
  retrieveNexus,
  searchDocuments,
  transcriptDocuments,
} from './retrieve.ts';
import { emptyNexus, evidenceFor, reviseRecord } from './state.ts';
import type { NexusRevision } from './types.ts';

const messages = [
  {
    id: 'a',
    name: 'Joe',
    mes: 'Joe lives in London.',
    is_user: false,
    is_system: false,
    send_date: '',
  },
  {
    id: 'b',
    name: 'Joe',
    mes: 'Joe moved to Paris.',
    is_user: false,
    is_system: false,
    send_date: '',
  },
];
const revision = (i: number): NexusRevision => ({
  text: messages[i]!.mes,
  kind: 'fact',
  assertion: 'claim',
  status: 'active',
  nodeIds: [],
  evidence: [evidenceFor(messages[i]!)],
  created: i,
  enabled: true,
  pinned: false,
  deleted: false,
  manual: false,
  cues: [],
});
test('superseded facts are searchable as history, never as current claims', () => {
  const n = { ...emptyNexus(), records: [{ id: 'home', revisions: [revision(0), revision(1)] }] };
  const docs = memoryDocuments(n, messages);
  expect(docs).toHaveLength(2);
  expect(docs[0]!.text).toStartWith('[Earlier]');
  expect(docs[1]!.text).toContain('[Reported claim]');
  expect(
    memoryDocuments(reviseRecord(n, 'home', { text: 'A manual correction' }, 'b'), messages),
  ).toHaveLength(1);
  expect(memoryDocuments(n, [{ ...messages[0]!, is_system: true }, messages[1]!])).toHaveLength(1);
});
test('pins and reviewed findings share a hard budget and report exclusions', () => {
  const n = {
    ...emptyNexus(),
    records: [{ id: 'a', revisions: [{ ...revision(0), pinned: true }] }],
  };
  const r = retrieveNexus({
    nexus: n,
    messages,
    query: 'anything',
    budget: 18,
    countTokens: (t) => t.length,
    findings: [
      {
        id: 'f',
        text: 'Paris.',
        nodeIds: [],
        evidence: [evidenceFor(messages[1]!)],
        selected: true,
      },
    ],
  });
  expect(r.text).toBe('• Paris.');
  expect(r.tokens).toBe(r.text.length);
  expect(r.hits.find((h) => h.recordId === 'a')?.included).toBe(false);
  expect(r.hits[0]?.reasons).toContain('Selected for this request');
});
test('incompatible content fingerprints cannot influence semantic recall', () => {
  const docs = memoryDocuments(
    { ...emptyNexus(), records: [{ id: 'a', revisions: [revision(0)] }] },
    messages,
  );
  expect(
    searchDocuments(
      docs,
      'spaceship',
      [{ documentId: docs[0]!.id, fingerprint: 'old', vector: [1, 0] }],
      [1, 0],
    ),
  ).toHaveLength(0);
});
test('a ubiquitous protagonist does not activate every memory', () => {
  const n = {
    ...emptyNexus(),
    records: Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      revisions: [{ ...revision(0), text: `Joe owns object number ${i}.`, cues: ['Joe'] }],
    })),
  };
  expect(
    retrieveNexus({
      nexus: n,
      messages,
      query: 'Joe wonders about a spaceship.',
      budget: 1200,
      countTokens: (t) => t.length,
    }).hits,
  ).toHaveLength(0);
});
test('transcript passage excerpts follow their chunk and exclude hidden messages', () => {
  const m = { ...messages[0]!, mes: `${'a'.repeat(900)}the secret code` };
  const docs = transcriptDocuments([m, { ...messages[1]!, is_system: true }]);
  expect(docs).toHaveLength(2);
  expect(docs[1]!.evidence[0]!.excerpt).toEndWith('the secret code');
});
