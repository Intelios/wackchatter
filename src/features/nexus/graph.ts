import { canonicalNode, liveRecords, nodeVersion } from '@shared/nexus/state.ts';
import type { NexusState } from '@shared/nexus/types.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
export function nexusGraph(nexus: NexusState, messages: readonly ChatMessage[]) {
  const nodes = nexus.nodes.filter((n) => !nodeVersion(n).deleted && !nodeVersion(n).mergedInto);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = liveRecords(nexus, messages)
    .flatMap(({ record, revision: r }) => {
      if (r.relation)
        return [
          {
            id: record.id,
            from: canonicalNode(nexus, r.relation.from),
            to: canonicalNode(nexus, r.relation.to),
            label: r.relation.label,
          },
        ];
      if (r.kind !== 'event') return [];
      const event = r.nodeIds.find((id) => byId.get(id)?.versions.at(-1)?.kind === 'event');
      return event
        ? r.nodeIds
            .filter((id) => id !== event)
            .map((id) => ({
              id: `${record.id}:${id}`,
              from: canonicalNode(nexus, event),
              to: canonicalNode(nexus, id),
              label: 'participates in',
            }))
        : [];
    })
    .filter((e) => e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to));
  return { nodes, edges };
}
/** Stable insertion order positions; additions never move an existing target. */
export function nodePosition(index: number) {
  const radius = 90 * Math.sqrt(index);
  const angle = index * 2.399963229728653;
  return { x: 500 + Math.cos(angle) * radius, y: 350 + Math.sin(angle) * radius };
}
