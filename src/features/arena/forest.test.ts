import { describe, expect, test } from 'bun:test';
import type { LeaderboardRow } from './elo.ts';
import { START_RATING } from './elo.ts';
import { FOREST_MIN_SPAN, forestBounds, forestPercent } from './forest.ts';
import type { RatingInterval } from './intervals.ts';

function row(id: string, rating: number): LeaderboardRow {
  return {
    contenderId: id,
    model: `${id}-model`,
    provider: 'openrouter',
    rating,
    rounds: 12,
    wins: 6,
    losses: 6,
    ties: 0,
    rejected: 0,
    provisional: false,
  };
}

function interval(id: string, low: number, high: number): RatingInterval {
  return { contenderId: id, low, high };
}

describe('forestBounds', () => {
  test('always includes the starting rating', () => {
    // The 1500 guide is the one reference line the plot draws, so it must be on the axis —
    // every whisker is read as a distance from where everyone began.
    const bounds = forestBounds([row('a', 1700)], new Map([['a', interval('a', 1650, 1750)]]));

    expect(bounds.min).toBeLessThanOrEqual(START_RATING);
    expect(bounds.max).toBeGreaterThanOrEqual(START_RATING);
  });

  test('covers every rating and both ends of every interval', () => {
    const rows = [row('a', 1540), row('b', 1470), row('c', 1500)];
    const intervals = new Map([
      ['a', interval('a', 1490, 1600)],
      ['b', interval('b', 1420, 1520)],
    ]);

    const bounds = forestBounds(rows, intervals);

    expect(bounds.min).toBeLessThanOrEqual(1420);
    expect(bounds.max).toBeGreaterThanOrEqual(1600);
  });

  test('an interval may reach past its own rating without being clipped', () => {
    // Nothing is clamped into the band: if a tiny history leaves the point at (or past)
    // an end, the axis must still have room to draw it there honestly.
    const bounds = forestBounds([row('a', 1516)], new Map([['a', interval('a', 1516, 1516)]]));

    expect(bounds.min).toBeLessThanOrEqual(1516);
    expect(bounds.max).toBeGreaterThanOrEqual(1516);
  });

  test('floors the span so early noise does not look like a rout', () => {
    const bounds = forestBounds([row('a', 1508)], new Map([['a', interval('a', 1495, 1520)]]));

    expect(bounds.max - bounds.min).toBeGreaterThanOrEqual(FOREST_MIN_SPAN);
  });

  test('an empty board still draws, centred on the start', () => {
    const bounds = forestBounds([], new Map());

    expect(bounds.min).toBeLessThan(START_RATING);
    expect(bounds.max).toBeGreaterThan(START_RATING);
    expect(Math.round((bounds.min + bounds.max) / 2)).toBe(START_RATING);
  });
});

describe('forestPercent', () => {
  test('maps the bounds ends to 0 and 100', () => {
    const bounds = { min: 1400, max: 1600 };

    expect(forestPercent(1400, bounds)).toBe(0);
    expect(forestPercent(1600, bounds)).toBe(100);
  });

  test('maps the midpoint to 50', () => {
    const bounds = { min: 1400, max: 1600 };

    expect(forestPercent(1500, bounds)).toBe(50);
  });

  test('a zero span centres rather than dividing by zero', () => {
    const bounds = { min: 1500, max: 1500 };

    expect(forestPercent(1500, bounds)).toBe(50);
  });
});
