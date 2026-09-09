import { latest, nodeVersion } from '@shared/nexus/state.ts';
import type { NexusNodeKind, NexusState } from '@shared/nexus/types.ts';

export interface NexusCounts {
  memories: number;
  person: number;
  place: number;
  object: number;
  event: number;
  group: number;
  concept: number;
}

const KINDS: readonly NexusNodeKind[] = ['person', 'place', 'object', 'event', 'group', 'concept'];
const PLURAL: Record<NexusNodeKind, string> = {
  person: 'people',
  place: 'places',
  object: 'objects',
  event: 'events',
  group: 'groups',
  concept: 'concepts',
};

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Counts over the same live set the map draws: nodes that are neither deleted
 * nor merged away, and records whose latest revision survives.
 */
export function nexusCounts(nexus: NexusState): NexusCounts {
  const counts: NexusCounts = {
    memories: 0,
    person: 0,
    place: 0,
    object: 0,
    event: 0,
    group: 0,
    concept: 0,
  };
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

/** Below one trillion epoch-ms (Sept 2001) nothing is a plausible creation time —
 * seeded fixtures and stray small integers are the epoch in disguise. */
const MIN_PLAUSIBLE_CREATED = 1_000_000_000_000;

/** A revision without a real timestamp must not read as 1 January 1970. */
export function revisionDateLabel(created: number): string {
  return Number.isFinite(created) && created >= MIN_PLAUSIBLE_CREATED
    ? new Date(created).toLocaleString()
    : 'Unknown';
}
