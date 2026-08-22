import { describe, expect, test } from 'bun:test';
import type { ArenaProbe, ArenaRound, Contender, Verdict } from '@shared/types/arena.ts';
import { createRng } from '@shared/worldinfo/rng.ts';
import { chooseCard, choosePair, drawRound } from './pairing.ts';

let clock = 0;

function round(
  left: string,
  right: string,
  characterId = 'a.png',
  verdict: Verdict = 'left',
): ArenaRound {
  clock += 1;
  return {
    id: `r${clock}`,
    created: clock,
    characterId,
    probe: 'Hello.',
    left: { contenderId: left, model: 'm', provider: 'openrouter', text: 'a' },
    right: { contenderId: right, model: 'm', provider: 'openrouter', text: 'b' },
    verdict,
  };
}

function contender(id: string): Contender {
  return { id, name: id, connectionId: 'or', model: `${id}/model`, enabled: true };
}

const probes: ArenaProbe[] = [{ id: 'p1', text: 'Say something.' }];

describe('choosePair', () => {
  test('needs two contenders', () => {
    expect(choosePair([], [], createRng('s'))).toBeNull();
    expect(choosePair([contender('a')], [], createRng('s'))).toBeNull();
  });

  test('prefers a pairing that has never happened over one that has', () => {
    const pool = [contender('a'), contender('b'), contender('c')];
    const history = [round('a', 'b'), round('a', 'b'), round('a', 'c')];

    // b vs c is the only unplayed pair, so it wins whatever the seed.
    for (const seed of ['1', '2', '3', 'x', 'y']) {
      const pair = choosePair(pool, history, createRng(seed));
      expect(pair?.map((entry) => entry.id).sort()).toEqual(['b', 'c']);
    }
  });

  test('a never-met pair beats a played one even when its members are the busiest', () => {
    // The scaling rule: pair count dominates the combined-total tie-break outright.
    const pool = [contender('a'), contender('b'), contender('c'), contender('d')];
    const history = [
      round('a', 'c'),
      round('a', 'd'),
      round('b', 'c'),
      round('b', 'd'),
      round('c', 'd'),
    ];

    const pair = choosePair(pool, history, createRng('seed'));
    expect(pair?.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
  });

  test('with every pair played equally, the least-busy pair is chosen', () => {
    const pool = [contender('a'), contender('b'), contender('c')];
    // Every pair has met once, but a and b have each fought twice while c fought twice too.
    // Adding an extra a-vs-b round makes a and b the busiest, so b-vs-c or a-vs-c wins.
    const history = [round('a', 'b'), round('a', 'c'), round('b', 'c'), round('a', 'b')];

    const pair = choosePair(pool, history, createRng('seed'));
    expect(pair?.map((entry) => entry.id).sort()).not.toEqual(['a', 'b']);
  });

  test('history against contenders no longer in the pool is ignored', () => {
    // `ghost` is gone; the a-vs-ghost rounds must not make `a` look busy and push it away
    // from the only pairing that is actually available.
    const pool = [contender('a'), contender('b')];
    const history = [round('a', 'ghost'), round('a', 'ghost'), round('a', 'ghost')];

    const pair = choosePair(pool, history, createRng('seed'));
    expect(pair?.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
  });

  test('the same seed and history give the same pair', () => {
    const pool = [contender('a'), contender('b'), contender('c'), contender('d')];
    const first = choosePair(pool, [], createRng('fixed'));
    const second = choosePair(pool, [], createRng('fixed'));

    expect(first?.map((entry) => entry.id)).toEqual(second?.map((entry) => entry.id) ?? []);
  });

  test('different seeds can pick different pairs from an empty history', () => {
    const pool = [contender('a'), contender('b'), contender('c'), contender('d')];
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const pair = choosePair(pool, [], createRng(`seed-${i}`));
      seen.add(pair?.map((entry) => entry.id).join('/') ?? '');
    }

    // All six pairings are equally unplayed, so the draw must actually be spreading.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('chooseCard', () => {
  test('returns null for an empty pool', () => {
    expect(chooseCard([], [], createRng('s'))).toBeNull();
  });

  test('prefers a card that has not been used', () => {
    const history = [round('a', 'b', 'used.png'), round('a', 'b', 'used.png')];

    expect(chooseCard(['used.png', 'fresh.png'], history, createRng('s'))).toBe('fresh.png');
  });

  test('a single card is always the answer', () => {
    expect(chooseCard(['only.png'], [round('a', 'b', 'only.png')], createRng('s'))).toBe(
      'only.png',
    );
  });
});

describe('drawRound', () => {
  const pool = [contender('a'), contender('b')];

  test('refuses to draw without probes, cards or a pair', () => {
    const base = { contenders: pool, cards: ['a.png'], probes, rounds: [], seed: 's' };

    expect(drawRound({ ...base, probes: [] })).toBeNull();
    expect(drawRound({ ...base, cards: [] })).toBeNull();
    expect(drawRound({ ...base, contenders: [contender('a')] })).toBeNull();
  });

  test('draws a complete, reproducible round', () => {
    const options = { contenders: pool, cards: ['a.png'], probes, rounds: [], seed: 'fixed' };
    const first = drawRound(options);
    const second = drawRound(options);

    expect(first).not.toBeNull();
    expect(first?.characterId).toBe('a.png');
    expect(first?.probe.id).toBe('p1');
    expect([first?.left.id, first?.right.id].sort()).toEqual(['a', 'b']);
    expect(first).toEqual(second);
  });

  test('the side each contender takes is a coin flip, not a fixed order', () => {
    const sides = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const draw = drawRound({
        contenders: pool,
        cards: ['a.png'],
        probes,
        rounds: [],
        seed: `seed-${i}`,
      });
      sides.add(`${draw?.left.id}`);
    }

    // Both contenders must appear on the left, or position bias would bind to one of them
    // for the whole history.
    expect(sides.size).toBe(2);
  });
});
