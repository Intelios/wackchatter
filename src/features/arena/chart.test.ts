import { describe, expect, test } from 'bun:test';
import { indexAt, MIN_SPAN, plotLine, plotX, plotY, ratingBounds, visibleSeries } from './chart.ts';
import type { RatingPoint, RatingSeries } from './elo.ts';
import { START_RATING } from './elo.ts';

function series(ratings: number[], contenderId = 'a'): RatingSeries {
  return {
    contenderId,
    model: 'm',
    points: ratings.map((rating, index): RatingPoint => ({ index, rating, delta: 0 })),
  };
}

describe('ratingBounds', () => {
  test('always contains the starting rating, so the 1500 guide is on the chart', () => {
    const high = ratingBounds([series([1700, 1800, 1900])]);
    expect(high.min).toBeLessThanOrEqual(START_RATING);

    const low = ratingBounds([series([1300, 1200, 1100])]);
    expect(low.max).toBeGreaterThanOrEqual(START_RATING);
  });

  test('a nearly flat history is not stretched to fill the plot', () => {
    // The lie this floor exists to prevent: three rounds of noise drawn as a rout.
    const bounds = ratingBounds([series([1500, 1508, 1492])]);
    expect(bounds.max - bounds.min).toBeGreaterThanOrEqual(MIN_SPAN);
  });

  test('an empty history still gives a drawable band around the start', () => {
    const bounds = ratingBounds([]);
    expect(bounds.max - bounds.min).toBeGreaterThanOrEqual(MIN_SPAN);
    expect(bounds.min).toBeLessThan(START_RATING);
    expect(bounds.max).toBeGreaterThan(START_RATING);
  });

  test('a wide history is bounded by its own data, plus padding', () => {
    const bounds = ratingBounds([series([1500, 1900, 1100])]);
    expect(bounds.min).toBeLessThan(1100);
    expect(bounds.max).toBeGreaterThan(1900);
  });

  test('every series is considered, not just the first', () => {
    const bounds = ratingBounds([series([1500], 'a'), series([2000], 'b')]);
    expect(bounds.max).toBeGreaterThanOrEqual(2000);
  });
});

describe('plotY', () => {
  const bounds = { min: 1400, max: 1600 };

  test('a higher rating is a lower y — SVG grows downward', () => {
    expect(plotY(1600, bounds, 100)).toBeLessThan(plotY(1400, bounds, 100));
  });

  test('the ends of the band land on the ends of the plot', () => {
    expect(plotY(1600, bounds, 100)).toBeCloseTo(0);
    expect(plotY(1400, bounds, 100)).toBeCloseTo(100);
    expect(plotY(1500, bounds, 100)).toBeCloseTo(50);
  });

  test('a zero-span band centres rather than dividing by zero', () => {
    expect(plotY(1500, { min: 1500, max: 1500 }, 100)).toBe(50);
  });
});

describe('plotX', () => {
  test('spreads the rounds evenly across the width', () => {
    expect(plotX(0, 5, 100)).toBe(0);
    expect(plotX(4, 5, 100)).toBe(100);
    expect(plotX(2, 5, 100)).toBe(50);
  });

  test('a single point sits at the left edge instead of dividing by zero', () => {
    expect(plotX(0, 1, 100)).toBe(0);
  });
});

describe('plotLine', () => {
  test('produces one coordinate pair per point', () => {
    const line = plotLine(series([1500, 1516, 1499]).points, { min: 1400, max: 1600 }, 100, 100);
    expect(line.split(' ')).toHaveLength(3);
    expect(line.startsWith('0.00,')).toBe(true);
  });

  test('an empty series draws nothing rather than throwing', () => {
    expect(plotLine([], { min: 1400, max: 1600 }, 100, 100)).toBe('');
  });
});

describe('visibleSeries', () => {
  const all = [series([1500, 1510], 'a'), series([1500, 1490], 'b'), series([1500, 1520], 'c')];

  test('no focus draws every line', () => {
    expect(visibleSeries(all, new Set())).toEqual(all);
  });

  test('a focus keeps only the picked lines, in the board order', () => {
    expect(visibleSeries(all, new Set(['c', 'a'])).map((entry) => entry.contenderId)).toEqual([
      'a',
      'c',
    ]);
  });

  test('a focus that matches nothing falls back to every line rather than a blank plot', () => {
    // The per-card filter can change under a focus and remove the picked entrants; the
    // chart must degrade to the full view, not to nothing.
    expect(visibleSeries(all, new Set(['gone']))).toEqual(all);
  });
});

describe('indexAt', () => {
  test('snaps to the nearest round, so the last one is reachable at the edge', () => {
    expect(indexAt(0, 5)).toBe(0);
    expect(indexAt(1, 5)).toBe(4);
    expect(indexAt(0.5, 5)).toBe(2);
    expect(indexAt(0.9, 5)).toBe(4);
  });

  test('clamps a pointer that has left the plot', () => {
    expect(indexAt(-0.4, 5)).toBe(0);
    expect(indexAt(1.6, 5)).toBe(4);
  });

  test('a single point is always index zero', () => {
    expect(indexAt(0.7, 1)).toBe(0);
  });
});
