import { describe, expect, test } from 'bun:test';
import type {
  Contender,
  RoundSide,
  TournamentMatch,
  TournamentSize,
  TournamentWithMatches,
} from '@shared/types/arena.ts';
import { tournamentLadder } from './ladder.ts';

let nextId = 0;

function side(contenderId: string, model: string): RoundSide {
  return { contenderId, model, provider: 'openrouter', text: '' };
}

function match(
  stage: number,
  matchIndex: number,
  left: string,
  right: string,
  verdict: 'left' | 'right',
  created: number,
  modelOf: (id: string) => string = (id) => `model-${id}`,
): TournamentMatch {
  nextId++;
  return {
    id: `m${nextId}`,
    tournamentId: 't',
    created,
    stage,
    matchIndex,
    characterId: 'x.png',
    cue: 'c',
    left: side(left, modelOf(left)),
    right: side(right, modelOf(right)),
    verdict,
    rerolled: false,
  };
}

function cup(
  id: string,
  created: number,
  entrants: string[],
  matches: TournamentMatch[],
  status: TournamentWithMatches['status'] = 'active',
  size: TournamentSize = 4,
): TournamentWithMatches {
  const stageCount = Math.log2(size);
  return {
    id,
    name: id,
    created,
    status,
    size,
    entrants,
    stages: Array.from({ length: stageCount }, (_, index) => ({
      characterId: `card-${index}.png`,
      cue: `c${index}`,
    })),
    matches: matches.map((entry) => ({ ...entry, tournamentId: id })),
  };
}

function contender(id: string, model = `model-${id}`): Contender {
  return { id, name: id, connectionId: 'conn', model, enabled: true };
}

describe('tournamentLadder points', () => {
  test('a win is worth its stage, so the final is worth more than the first round', () => {
    // a beats b, c beats d, then a beats c in the final.
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [
          match(0, 0, 'a', 'b', 'left', 10),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'a', 'c', 'left', 12),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    const points = new Map(rows.map((row) => [row.contenderId, row.points]));

    expect(points.get('a')).toBe(3); // 1 for the semi + 2 for the final
    expect(points.get('c')).toBe(1);
    expect(points.get('b')).toBe(0);
    expect(points.get('d')).toBe(0);
  });

  test('a loss never subtracts — a semi-finalist keeps what it earned', () => {
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [
          match(0, 0, 'a', 'b', 'left', 10),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'a', 'c', 'right', 12),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    const c = rows.find((row) => row.contenderId === 'c')!;
    const a = rows.find((row) => row.contenderId === 'a')!;

    expect(c.points).toBe(3); // won the semi (1) and the final (2)
    expect(c.losses).toBe(0);
    expect(a.points).toBe(1); // won the semi, lost the final, lost nothing
    expect(a.losses).toBe(1);
    expect(rows.every((row) => row.points >= 0)).toBe(true);
  });

  test('counts wins and losses per match, not per tournament', () => {
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [
          match(0, 0, 'a', 'b', 'left', 10),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'a', 'c', 'left', 12),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    const a = rows.find((row) => row.contenderId === 'a')!;
    const b = rows.find((row) => row.contenderId === 'b')!;

    expect(a).toMatchObject({ wins: 2, losses: 0, titles: 1, tournaments: 1 });
    expect(b).toMatchObject({ wins: 0, losses: 1, titles: 0, tournaments: 1 });
  });

  test('a pool contender that has not played is seeded at zero, not absent', () => {
    const rows = tournamentLadder([], [contender('z')]);
    expect(rows).toEqual([
      expect.objectContaining({ contenderId: 'z', points: 0, wins: 0, tournaments: 0 }),
    ]);
  });

  test('points accumulate across tournaments', () => {
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [
          match(0, 0, 'a', 'b', 'left', 10),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'a', 'c', 'left', 12),
        ],
      ),
      cup(
        't2',
        100,
        ['a', 'c', 'e', 'f'],
        [
          match(0, 0, 'a', 'c', 'left', 110),
          match(0, 1, 'e', 'f', 'left', 111),
          match(1, 0, 'a', 'e', 'left', 112),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    const a = rows.find((row) => row.contenderId === 'a')!;
    expect(a.points).toBe(6); // 3 + 3
    expect(a.titles).toBe(2);
    expect(a.tournaments).toBe(2);
    expect(a.byTournament).toEqual([
      { tournamentId: 't1', points: 3, wins: 2 },
      { tournamentId: 't2', points: 3, wins: 2 },
    ]);
  });
});

describe('tournamentLadder retention', () => {
  test('a contender missing from the pool keeps the points its matches earned', () => {
    const tournaments = [
      cup(
        't1',
        1,
        ['ghost', 'b', 'c', 'd'],
        [
          match(0, 0, 'ghost', 'b', 'left', 10, (id) => `model-${id}`),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'ghost', 'c', 'left', 12),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    const ghost = rows.find((row) => row.contenderId === 'ghost')!;

    expect(ghost.points).toBe(3);
    expect(ghost.model).toBe('model-ghost');
    expect(ghost.provider).toBe('openrouter');
  });

  test('an abandoned tournament still pays out the matches that were played', () => {
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [match(0, 0, 'a', 'b', 'left', 10), match(0, 1, 'c', 'd', 'left', 11)],
        'abandoned',
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    expect(rows.find((row) => row.contenderId === 'a')?.points).toBe(1);
    expect(rows.find((row) => row.contenderId === 'c')?.points).toBe(1);
  });

  test('a deleted tournament contributes nothing, because its matches are gone', () => {
    const rows = tournamentLadder([], [contender('a')]);
    expect(rows.find((row) => row.contenderId === 'a')?.points).toBe(0);
  });

  test('the model recorded on the newest match is the fallback label', () => {
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [
          match(0, 0, 'a', 'b', 'left', 10, () => 'old/model'),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'a', 'c', 'left', 12, (id) => (id === 'a' ? 'new/model' : 'other')),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    expect(rows.find((row) => row.contenderId === 'a')?.model).toBe('new/model');
  });
});

describe('tournamentLadder ordering', () => {
  test('orders by points descending', () => {
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [
          match(0, 0, 'a', 'b', 'left', 10),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'a', 'c', 'left', 12),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    expect(rows.map((row) => row.contenderId)).toEqual(['a', 'c', 'b', 'd']);
  });

  test('breaks a points tie on the head-to-head result between the tied contenders', () => {
    /*
     * a beats b in t1's final (a takes 3, b takes 0 from that bracket). b then wins t2
     * outright for 3. Both stand on 3, and a won the only match they played — so a ranks
     * above b even though b's first win came later.
     */
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [
          match(0, 0, 'a', 'b', 'left', 10),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'a', 'c', 'left', 12),
        ],
      ),
      cup(
        't2',
        100,
        ['b', 'e', 'f', 'g'],
        [
          match(0, 0, 'b', 'e', 'left', 110),
          match(0, 1, 'f', 'g', 'left', 111),
          match(1, 0, 'b', 'f', 'left', 112),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    const a = rows.findIndex((row) => row.contenderId === 'a');
    const b = rows.findIndex((row) => row.contenderId === 'b');

    expect(rows[a]?.points).toBe(3);
    expect(rows[b]?.points).toBe(3);
    expect(a).toBeLessThan(b);
  });

  test('falls back to the earlier first win, then to id, when the tie never met', () => {
    // Two separate brackets, same points, no shared match: t1's champion played first.
    const tournaments = [
      cup(
        't1',
        1,
        ['a', 'b', 'c', 'd'],
        [
          match(0, 0, 'a', 'b', 'left', 10),
          match(0, 1, 'c', 'd', 'left', 11),
          match(1, 0, 'a', 'c', 'left', 12),
        ],
      ),
      cup(
        't2',
        100,
        ['e', 'f', 'g', 'h'],
        [
          match(0, 0, 'e', 'f', 'left', 110),
          match(0, 1, 'g', 'h', 'left', 111),
          match(1, 0, 'e', 'g', 'left', 112),
        ],
      ),
    ];

    const rows = tournamentLadder(tournaments, []);
    const a = rows.findIndex((row) => row.contenderId === 'a');
    const e = rows.findIndex((row) => row.contenderId === 'e');

    expect(a).toBeLessThan(e); // same 3 points, a's first win is earlier
  });

  test('last place is deterministic even among contenders that never won', () => {
    const rows = tournamentLadder([], [contender('zeta'), contender('alpha')]);
    expect(rows.map((row) => row.contenderId)).toEqual(['alpha', 'zeta']);
  });
});
