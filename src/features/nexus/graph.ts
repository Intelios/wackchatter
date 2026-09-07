import { canonicalNode, liveRecords, nodeVersion } from '@shared/nexus/state.ts';
import type { NexusState } from '@shared/nexus/types.ts';
import type { ChatMessage } from '@shared/types/chat.ts';

export interface NexusGraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  /** A co-mention pair derived by the view, not a connection anyone extracted. */
  implicit?: true;
}

export function nexusGraph(nexus: NexusState, messages: readonly ChatMessage[]) {
  const nodes = nexus.nodes.filter((n) => !nodeVersion(n).deleted && !nodeVersion(n).mergedInto);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // A record that names several entities but carries no relation and no event draws
  // no explicit edge — count its shared mentions so the map still shows the cluster.
  const pairs = new Map<string, { from: string; to: string; count: number }>();
  const edges: NexusGraphEdge[] = [];
  for (const { record, revision: r } of liveRecords(nexus, messages)) {
    if (r.relation) {
      edges.push({
        id: record.id,
        from: canonicalNode(nexus, r.relation.from),
        to: canonicalNode(nexus, r.relation.to),
        label: r.relation.label,
      });
      continue;
    }
    if (r.kind === 'event') {
      const event = r.nodeIds.find((id) => byId.get(id)?.versions.at(-1)?.kind === 'event');
      if (event) {
        for (const id of r.nodeIds.filter((id) => id !== event))
          edges.push({
            id: `${record.id}:${id}`,
            from: canonicalNode(nexus, event),
            to: canonicalNode(nexus, id),
            label: 'participates in',
          });
        continue;
      }
    }
    const ids = [...new Set(r.nodeIds.map((id) => canonicalNode(nexus, id)))].filter((id) =>
      nodeIds.has(id),
    );
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const from = ids[i]! < ids[j]! ? ids[i]! : ids[j]!;
        const to = ids[i]! < ids[j]! ? ids[j]! : ids[i]!;
        const entry = pairs.get(`${from}:${to}`) ?? { from, to, count: 0 };
        entry.count++;
        pairs.set(`${from}:${to}`, entry);
      }
  }
  const kept = edges.filter((e) => e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to));
  // A pair already joined by an explicit edge is connected; a co-mention edge over it
  // would stack a dotted line and a second label on the same segment.
  const joined = new Set(
    kept.map((e) => (e.from < e.to ? `${e.from}:${e.to}` : `${e.to}:${e.from}`)),
  );
  // Explicit edges first: the explorer caps rendering at 500, and an asserted
  // connection must not be the one dropped for a derived one.
  return {
    nodes,
    edges: [
      ...kept,
      ...[...pairs.values()]
        .filter((p) => p.from !== p.to && !joined.has(`${p.from}:${p.to}`))
        .map(({ from, to, count }) => ({
          id: `co:${from}:${to}`,
          from,
          to,
          label: `${count} shared ${count === 1 ? 'memory' : 'memories'}`,
          implicit: true as const,
        })),
    ],
  };
}
/** Stable insertion order positions; additions never move an existing target. */
export function nodePosition(index: number) {
  const radius = 90 * Math.sqrt(index);
  const angle = index * 2.399963229728653;
  return { x: 500 + Math.cos(angle) * radius, y: 350 + Math.sin(angle) * radius };
}
