import { describe, expect, test } from 'bun:test';
import type { NexusNode, NexusRecord, NexusState } from '@shared/nexus/types.ts';
import { nexusCounts, nexusSummaryLine, plural } from './summaryLine.ts';

function node(id: string, kind: NexusNode['versions'][number]['kind'], extra = {}) {
  return { id, versions: [{ name: id, aliases: [], kind, evidence: [], manual: true, ...extra }] };
}
function record(id: string, deleted = false) {
  return {
    id,
    revisions: [
      {
        text: id,
        kind: 'fact' as const,
        assertion: 'fact' as const,
        status: 'active' as const,
        nodeIds: [],
        evidence: [],
        created: 0,
        enabled: true,
        pinned: false,
        deleted,
        manual: false,
        cues: [],
      },
    ],
  };
}
function state(nodes: NexusNode[], records: NexusRecord[]): NexusState {
  return { version: 1, nodes, records, processed: {}, initialized: true, paused: false };
}

describe('nexusCounts', () => {
  test('counts live nodes by kind and surviving records', () => {
    const counts = nexusCounts(
      state(
        [
          node('a', 'person'),
          node('b', 'person'),
          node('c', 'place'),
          node('d', 'object'),
          node('e', 'event'),
        ],
        [record('r1'), record('r2'), record('r3', true)],
      ),
    );
    expect(counts).toEqual({ memories: 2, person: 2, place: 1, object: 1, event: 1 });
  });

  test('deleted and merged-away nodes hold no slot', () => {
    const counts = nexusCounts(
      state(
        [
          node('a', 'person', { deleted: true }),
          node('b', 'place', { mergedInto: 'a' }),
          node('c', 'person'),
        ],
        [],
      ),
    );
    expect(counts.person).toBe(1);
    expect(counts.place).toBe(0);
  });
});

describe('plural', () => {
  test('regular and irregular forms', () => {
    expect(plural(0, 'message')).toBe('0 messages');
    expect(plural(1, 'message')).toBe('1 message');
    expect(plural(1, 'person', 'people')).toBe('1 person');
    expect(plural(2, 'person', 'people')).toBe('2 people');
  });
});

describe('nexusSummaryLine', () => {
  test('leads with memories, then every node kind', () => {
    expect(nexusSummaryLine({ memories: 12, person: 3, place: 5, object: 4, event: 0 })).toBe(
      '12 memories · 3 people · 5 places · 4 objects · 0 events',
    );
  });

  test('pluralises each segment independently', () => {
    expect(nexusSummaryLine({ memories: 1, person: 1, place: 2, object: 0, event: 1 })).toBe(
      '1 memory · 1 person · 2 places · 0 objects · 1 event',
    );
  });

  test('a nexus without memories says so, whatever nodes exist', () => {
    expect(nexusSummaryLine({ memories: 0, person: 2, place: 0, object: 0, event: 0 })).toBe(
      'No memories yet',
    );
  });
});
