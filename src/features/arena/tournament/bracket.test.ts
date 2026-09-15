import { describe, expect, test } from 'bun:test';
import type { TournamentMatch, TournamentWithMatches } from '@shared/types/arena.ts';
import { bracketView, loserIdOf, seedEntrants, stageName, winnerIdOf } from './bracket.ts';

let nextId = 0;

function match(partial: {
  stage: number;
  matchIndex: number;
  left: string;
  right: string;
  verdict: 'left' | 'right';
  created?: number;
  tournamentId?: string;
}): TournamentMatch {
  nextId++;
  return {
    id: `m${nextId}`,
    tournamentId: partial.tournamentId ?? 't1',
    created: partial.created ?? nextId,
    stage: partial.stage,
    matchIndex: partial.matchIndex,
    characterId: 'x.png',
    cue: 'c',
    left: { contenderId: partial.left, model: '', provider: '', text: '' },
    right: { contenderId: partial.right, model: '', provider: '', text: '' },
    verdict: partial.verdict,
    rerolled: false,
  };
}

function tournament(overrides: Partial<TournamentWithMatches> = {}): TournamentWithMatches {
  return {
    id: 't1',
    name: 'Cup',
    created: 1,
    status: 'active',
    size: 4,
    entrants: ['a', 'b', 'c', 'd'],
    stages: [
      { characterId: 'x.png', cue: 'c0' },
      { characterId: 'y.png', cue: 'c1' },
    ],
    matches: [],
    ...overrides,
  };
}

describe('bracketView', () => {
  test('stage 0 pairs the entrants in slot order', () => {
    const view = bracketView(tournament());

    expect(view.stages[0]?.[0]).toMatchObject({ leftId: 'a', rightId: 'b', match: null });
    expect(view.stages[0]?.[1]).toMatchObject({ leftId: 'c', rightId: 'd', match: null });
  });

  test('the next match is the first playable unplayed slot', () => {
    const view = bracketView(tournament());
    expect(view.next).toMatchObject({ stage: 0, matchIndex: 0 });

    const after = bracketView(
      tournament({
        matches: [match({ stage: 0, matchIndex: 0, left: 'a', right: 'b', verdict: 'left' })],
      }),
    );
    expect(after.next).toMatchObject({ stage: 0, matchIndex: 1 });
  });

  test('a later stage has no sides until both its feeders are recorded', () => {
    const oneFeeder = bracketView(
      tournament({
        matches: [match({ stage: 0, matchIndex: 0, left: 'a', right: 'b', verdict: 'left' })],
      }),
    );
    // The final is not playable yet: one semi is still open.
    expect(oneFeeder.stages[1]?.[0]).toMatchObject({ leftId: 'a', rightId: null });
    expect(oneFeeder.next).toMatchObject({ stage: 0, matchIndex: 1 });

    const bothFeeders = bracketView(
      tournament({
        matches: [
          match({ stage: 0, matchIndex: 0, left: 'a', right: 'b', verdict: 'left' }),
          match({ stage: 0, matchIndex: 1, left: 'c', right: 'd', verdict: 'right' }),
        ],
      }),
    );
    expect(bothFeeders.stages[1]?.[0]).toMatchObject({ leftId: 'a', rightId: 'd' });
    expect(bothFeeders.next).toMatchObject({ stage: 1, matchIndex: 0 });
  });

  test('the final recorded decides the champion and completes the bracket', () => {
    const view = bracketView(
      tournament({
        matches: [
          match({ stage: 0, matchIndex: 0, left: 'a', right: 'b', verdict: 'left' }),
          match({ stage: 0, matchIndex: 1, left: 'c', right: 'd', verdict: 'right' }),
          match({ stage: 1, matchIndex: 0, left: 'a', right: 'd', verdict: 'right' }),
        ],
      }),
    );

    expect(view.championId).toBe('d');
    expect(view.complete).toBe(true);
    expect(view.next).toBeNull();
  });

  test('an unfinished bracket is not complete and has no champion', () => {
    const view = bracketView(tournament());
    expect(view.championId).toBeNull();
    expect(view.complete).toBe(false);
  });

  test('counts only matches that land in a slot of this bracket', () => {
    const view = bracketView(
      tournament({
        matches: [
          match({ stage: 0, matchIndex: 0, left: 'a', right: 'b', verdict: 'left' }),
          // A stage this bracket does not have: readable evidence, but it cannot advance anyone.
          match({ stage: 9, matchIndex: 0, left: 'a', right: 'b', verdict: 'left' }),
        ],
      }),
    );

    expect(view.playedMatches).toBe(1);
    expect(view.totalMatches).toBe(3);
  });

  test('a winner takes the side the verdict named, and the loser the other', () => {
    const decided = match({ stage: 0, matchIndex: 0, left: 'a', right: 'b', verdict: 'right' });
    expect(winnerIdOf(decided)).toBe('b');
    expect(loserIdOf(decided)).toBe('a');
  });

  test('an 8-bracket runs three stages and waits on the right feeders', () => {
    const view = bracketView(
      tournament({
        size: 8,
        entrants: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        stages: [
          { characterId: 'x.png', cue: 'c0' },
          { characterId: 'y.png', cue: 'c1' },
          { characterId: 'z.png', cue: 'c2' },
        ],
      }),
    );

    expect(view.stages.map((row) => row.length)).toEqual([4, 2, 1]);
    expect(view.totalMatches).toBe(7);
    expect(view.next).toMatchObject({ stage: 0, matchIndex: 0 });
  });
});

describe('seedEntrants', () => {
  test('is a permutation — nobody is lost or duplicated', () => {
    const entrants = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const seeded = seedEntrants(entrants, 'seed-1');
    expect([...seeded].sort()).toEqual([...entrants].sort());
  });

  test('is deterministic for one seed', () => {
    const entrants = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(seedEntrants(entrants, 'seed-1')).toEqual(seedEntrants(entrants, 'seed-1'));
  });

  test('a different seed draws a different bracket', () => {
    const entrants = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(seedEntrants(entrants, 'seed-1')).not.toEqual(seedEntrants(entrants, 'seed-2'));
  });

  test('leaves the input untouched', () => {
    const entrants = ['a', 'b', 'c', 'd'];
    const before = [...entrants];
    seedEntrants(entrants, 'seed-1');
    expect(entrants).toEqual(before);
  });
});

describe('stageName', () => {
  test('names each depth by how many contenders are still in it', () => {
    expect(stageName(16, 0)).toBe('Round of 16');
    expect(stageName(16, 1)).toBe('Quarter-finals');
    expect(stageName(8, 0)).toBe('Quarter-finals');
    expect(stageName(8, 1)).toBe('Semi-finals');
    expect(stageName(4, 0)).toBe('Semi-finals');
    expect(stageName(4, 1)).toBe('Final');
    expect(stageName(8, 2)).toBe('Final');
  });
});
