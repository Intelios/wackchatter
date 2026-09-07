import { expect, test } from 'bun:test';
import { memoryDocuments, retrieveNexus } from '@shared/nexus/retrieve.ts';
import { emptyNexus, evidenceFor } from '@shared/nexus/state.ts';
import type { NexusNode, NexusRecord } from '@shared/nexus/types.ts';
import { nexusGraph, nodePosition } from './graph.ts';

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
