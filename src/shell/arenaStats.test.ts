import { describe, expect, test } from 'bun:test';
import type { ArenaRound, RoundSide, Verdict } from '@shared/types/arena.ts';
import { replay } from '../features/arena/elo.ts';
import {
  bestPerCard,
  form,
  latestSitting,
  lengthVsWins,
  roundsCost,
  SITTING_GAP_MS,
  sideCost,
  sittings,
  upsets,
  voteMix,
  wordCount,
} from './arenaStats.ts';

const MIN = 60_000;
let serial = 0;

function side(contenderId: string, text = 'one two three', usage?: RoundSide['usage']): RoundSide {
  return {
    contenderId,
    model: `${contenderId}-model`,
    provider: 'p',
    text,
    ...(usage ? { usage } : {}),
  };
}

function round(
  left: string,
  right: string,
  verdict: Verdict,
  created: number,
  extra: Partial<ArenaRound> = {},
): ArenaRound {
  serial++;
  return {
    id: `r${serial}`,
    created,
    characterId: 'mika.png',
    probe: '',
    left: side(left),
    right: side(right),
    verdict,
    ...extra,
  };
}

describe('sittings', () => {
  test('a pause longer than the gap starts a new sitting', () => {
    const rounds = [
      round('a', 'b', 'left', 0),
      round('a', 'b', 'left', 10 * MIN),
      round('a', 'b', 'left', 10 * MIN + SITTING_GAP_MS + 1),
    ];
    const cut = sittings(rounds);
    expect(cut.map((s) => [s.from, s.to])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  test('the latest sitting’s moves add up to the board either side of it', () => {
    const old = round('a', 'b', 'left', 0);
    const night = [
      round('a', 'b', 'right', 5 * 60 * MIN),
      round('b', 'c', 'left', 5 * 60 * MIN + MIN),
    ];
    const all = [old, ...night];
    const summary = latestSitting(all, [], 5 * 60 * MIN + 2 * MIN);
    expect(summary?.rounds).toEqual(night);
    const before = new Map(replay([old]).rows.map((r) => [r.contenderId, r.rating]));
    const after = new Map(replay(all).rows.map((r) => [r.contenderId, r.rating]));
    for (const id of ['a', 'b', 'c']) {
      expect(summary?.moves.get(id)).toBe((after.get(id) ?? 1500) - (before.get(id) ?? 1500));
    }
    expect(summary?.records.get('b')).toEqual({ wins: 2, losses: 0, ties: 0 });
  });

  test('a sitting that ended long ago is not "this sitting"', () => {
    const rounds = [round('a', 'b', 'left', 0)];
    expect(latestSitting(rounds, [], 48 * 60 * MIN)).toBeNull();
  });
});

describe('form', () => {
  test('the last results, oldest first, from the contender’s own side', () => {
    const rounds = [
      round('a', 'b', 'left', 1),
      round('b', 'a', 'left', 2),
      round('a', 'c', 'tie', 3),
      round('c', 'a', 'bad', 4),
      round('b', 'c', 'left', 5),
    ];
    expect(form(rounds, 'a')).toEqual(['w', 'l', 't', 'b']);
    expect(form(rounds, 'a', 2)).toEqual(['t', 'b']);
  });
});

describe('bestPerCard', () => {
  test('ranks by share of points, and leaves out a model with too few rounds there', () => {
    const rounds = [
      round('a', 'b', 'left', 1),
      round('a', 'b', 'left', 2),
      round('a', 'b', 'tie', 3),
      round('c', 'a', 'left', 4),
    ];
    const [mika] = bestPerCard(rounds, 3);
    expect(mika?.leaders.map((l) => l.contenderId)).toEqual(['a', 'b']);
    expect(mika?.leaders[0]).toMatchObject({ wins: 2, losses: 1, ties: 1, share: 2.5 / 4 });
  });
});

describe('lengthVsWins and voteMix', () => {
  test('average words per reply against points per rated round', () => {
    const rounds = [
      round('a', 'b', 'left', 1, { left: side('a', 'w w w w'), right: side('b', 'w w') }),
      round('a', 'b', 'bad', 2, { left: side('a', 'w w'), right: side('b', 'w w') }),
    ];
    const points = lengthVsWins(rounds, 1);
    expect(points.find((p) => p.contenderId === 'a')).toEqual({
      contenderId: 'a',
      words: 3,
      share: 1,
      rounds: 1,
    });
    const mix = voteMix(rounds, 1);
    expect([mix.left, mix.right, mix.tie, mix.bad, mix.total]).toEqual([1, 0, 0, 1, 2]);
    expect(mix.bothBad.find((b) => b.contenderId === 'a')?.share).toBe(0.5);
  });

  test('wordCount ignores spacing', () => {
    expect(wordCount('  one\ntwo   three ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});

describe('upsets', () => {
  test('a lower-rated winner, measured as they stood going in', () => {
    const rounds = [
      round('a', 'b', 'left', 1),
      round('a', 'b', 'left', 2),
      round('b', 'a', 'left', 3),
    ];
    const [upset] = upsets(rounds, []);
    expect(upset?.winnerId).toBe('b');
    expect(upset?.number).toBe(3);
    const points = replay(rounds.slice(0, 2)).rows;
    const rating = (id: string) => points.find((r) => r.contenderId === id)?.rating ?? 0;
    expect(upset?.gap).toBe(rating('a') - rating('b'));
  });
});

describe('cost', () => {
  const usage = {
    connectionId: 'c',
    promptTokens: 1000,
    completionTokens: 200,
    ms: 1,
    firstTokenMs: 1,
  };
  const price = { prompt: 1e-6, completion: 4e-6 };

  test('a side is priced from its recorded tokens; no usage or no price is null', () => {
    expect(sideCost(side('a', '', usage), () => price)).toBeCloseTo(0.0018);
    expect(sideCost(side('a'), () => price)).toBeNull();
    expect(sideCost(side('a', '', usage), () => null)).toBeNull();
  });

  test('a total says whether every reply could be priced', () => {
    const priced = round('a', 'b', 'left', 1, {
      left: side('a', '', usage),
      right: side('b', '', usage),
    });
    const old = round('a', 'b', 'left', 2);
    expect(roundsCost([priced], () => price)).toMatchObject({
      complete: true,
      priced: true,
      tokens: 2400,
    });
    const mixed = roundsCost([priced, old], () => price);
    expect(mixed.complete).toBe(false);
    expect(mixed.usd).toBeCloseTo(0.0036);
  });
});
