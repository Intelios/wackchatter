import { expect, test } from 'bun:test';
import { memoryDocuments, retrieveNexus } from '@shared/nexus/retrieve.ts';
import { emptyNexus, evidenceFor } from '@shared/nexus/state.ts';
import type {
  NexusEvidence,
  NexusNode,
  NexusNodeVersion,
  NexusRecord,
  NexusRevision,
} from '@shared/nexus/types.ts';
import { nexusGraph, nodePosition } from './graph.ts';

function person(
  id: string,
  evidence: NexusEvidence[],
  kind: NexusNodeVersion['kind'] = 'person',
): NexusNode {
  return { id, versions: [{ name: id, aliases: [], kind, manual: false, evidence }] };
}

function revision(patch: Partial<NexusRevision> & { nodeIds: string[] }): NexusRevision {
  return {
    text: 'A memory.',
    kind: 'fact',
    assertion: 'fact',
    status: 'active',
    evidence: [],
    created: 0,
    enabled: true,
    pinned: false,
    deleted: false,
    manual: false,
    cues: [],
    ...patch,
  };
}

test('large maps derive only supported connections and keep existing positions stable', () => {
  const message = {
    id: 'm',
    name: 'Story',
    mes: 'Supported evidence.',
    is_user: false,
    is_system: false,
    send_date: '',
  };
  const evidence = [evidenceFor(message)];
  const nodes: NexusNode[] = Array.from({ length: 4000 }, (_, i) => ({
    id: `n${i}`,
    versions: [{ name: `Person ${i}`, aliases: [], kind: 'person', manual: false, evidence }],
  }));
  const records: NexusRecord[] = nodes.map((n, i) => ({
    id: `r${i}`,
    revisions: [
      {
        text: `Person ${i} promised to bring item ${i}.`,
        kind: 'thread',
        assertion: 'intention',
        status: 'active',
        nodeIds: [n.id],
        evidence,
        created: i,
        enabled: true,
        pinned: false,
        deleted: false,
        manual: false,
        cues: [],
      },
    ],
  }));
  const nexus = { ...emptyNexus(), nodes, records };
  const before = performance.now();
  const graph = nexusGraph(nexus, [message]);
  expect(graph.nodes).toHaveLength(4000);
  expect(graph.edges).toHaveLength(0);
  const docs = memoryDocuments(nexus, [message]);
  expect(docs).toHaveLength(4000);
  const recall = retrieveNexus({
    nexus,
    messages: [message],
    query: 'Person 1500',
    budget: 1200,
    countTokens: (t) => Math.ceil(t.length / 4),
  });
  expect(recall.hits.filter((h) => h.included).length).toBeLessThanOrEqual(3);
  expect(nodePosition(15)).toEqual(nodePosition(15));
  // Loose regression bound, not a claim about browser frame rates.
  expect(performance.now() - before).toBeLessThan(1500);
});

test('records that only name several nodes still connect them, one dotted edge per pair', () => {
  const message = {
    id: 'm',
    name: 'Story',
    mes: 'Anna promised Joe to keep his departure secret from Mary.',
    is_user: false,
    is_system: false,
    send_date: '',
  };
  const evidence = [evidenceFor(message)];
  const nexus = {
    ...emptyNexus(),
    nodes: ['anna', 'joe', 'mary'].map((id) => person(id, evidence)),
    records: [{ id: 'r1', revisions: [revision({ nodeIds: ['anna', 'joe', 'mary'], evidence })] }],
  };
  const graph = nexusGraph(nexus, [message]);

  expect(graph.edges.map((e) => [e.from, e.to].sort().join('+')).sort()).toEqual([
    'anna+joe',
    'anna+mary',
    'joe+mary',
  ]);
  for (const e of graph.edges) {
    expect(e.implicit).toBe(true);
    expect(e.label).toBe('1 shared memory');
  }
});

test('co-mention counts aggregate per pair and explicit connections never double-draw', () => {
  const message = {
    id: 'm',
    name: 'Story',
    mes: 'Anna is from London. There was a party.',
    is_user: false,
    is_system: false,
    send_date: '',
  };
  const evidence = [evidenceFor(message)];
  const nexus = {
    ...emptyNexus(),
    nodes: [
      person('anna', evidence),
      person('joe', evidence),
      person('mary', evidence),
      person('london', evidence, 'place'),
      person('party', evidence, 'event'),
    ],
    records: [
      { id: 'r1', revisions: [revision({ nodeIds: ['anna', 'joe', 'mary'], evidence })] },
      { id: 'r2', revisions: [revision({ nodeIds: ['anna', 'joe'], evidence })] },
      {
        id: 'r3',
        revisions: [
          revision({
            nodeIds: ['anna', 'london'],
            evidence,
            relation: { from: 'anna', to: 'london', label: 'is from' },
          }),
        ],
      },
      {
        id: 'r4',
        revisions: [
          revision({
            nodeIds: ['party', 'anna', 'joe'],
            evidence,
            kind: 'event',
            assertion: 'event',
          }),
        ],
      },
    ],
  };
  const graph = nexusGraph(nexus, [message]);

  expect(
    graph.edges
      .filter((e) => !e.implicit)
      .map((e) => `${e.from}-${e.to}:${e.label}`)
      .sort(),
  ).toEqual(['anna-london:is from', 'party-anna:participates in', 'party-joe:participates in']);
  expect(
    graph.edges
      .filter((e) => e.implicit)
      .map((e) => `${e.from}-${e.to}:${e.label}`)
      .sort(),
  ).toEqual([
    'anna-joe:2 shared memories',
    'anna-mary:1 shared memory',
    'joe-mary:1 shared memory',
  ]);
});

test('merged and unknown nodes never yield a self-pair', () => {
  const message = {
    id: 'm',
    name: 'Story',
    mes: 'Joe is really Anna by another name.',
    is_user: false,
    is_system: false,
    send_date: '',
  };
  const evidence = [evidenceFor(message)];
  const merged: NexusNode = {
    id: 'joe',
    versions: [
      { name: 'Joe', aliases: [], kind: 'person', manual: false, evidence },
      { name: 'Joe', aliases: [], kind: 'person', manual: false, evidence, mergedInto: 'anna' },
    ],
  };
  const nexus = {
    ...emptyNexus(),
    nodes: [person('anna', evidence), merged],
    records: [{ id: 'r1', revisions: [revision({ nodeIds: ['joe', 'ghost', 'anna'], evidence })] }],
  };
  const graph = nexusGraph(nexus, [message]);

  expect(graph.nodes.map((n) => n.id)).toEqual(['anna']);
  expect(graph.edges).toHaveLength(0);
});
