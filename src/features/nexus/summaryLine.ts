import { latest, nodeVersion } from '@shared/nexus/state.ts';
import type { NexusNodeKind, NexusState } from '@shared/nexus/types.ts';

export interface NexusCounts {
  memories: number;
  person: number;
  place: number;
  object: number;
  event: number;
}

const KINDS: readonly NexusNodeKind[] = ['person', 'place', 'object', 'event'];
const PLURAL: Record<NexusNodeKind, string> = {
  person: 'people',
  place: 'places',
  object: 'objects',
  event: 'events',
};

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Counts over the same live set the map draws: nodes that are neither deleted
 * nor merged away, and records whose latest revision survives.
 */
export function nexusCounts(nexus: NexusState): NexusCounts {
  const counts: NexusCounts = { memories: 0, person: 0, place: 0, object: 0, event: 0 };
  for (const node of nexus.nodes) {
    const v = nodeVersion(node);
    if (v.deleted || v.mergedInto) continue;
    if (KINDS.includes(v.kind)) counts[v.kind]++;
  }
  for (const record of nexus.records) if (!latest(record).deleted) counts.memories++;
  return counts;
}

/** The one-line knowledge summary the memory panel leads with and the explorer footer shows. */
export function nexusSummaryLine(counts: NexusCounts): string {
  if (!counts.memories) return 'No memories yet';
  return [
    plural(counts.memories, 'memory', 'memories'),
    ...KINDS.map((k) => plural(counts[k], k, PLURAL[k])),
  ].join(' · ');
}
