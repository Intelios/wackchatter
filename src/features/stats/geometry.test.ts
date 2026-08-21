import { describe, expect, test } from 'bun:test';
import { columnHeights, donutSegments, polar, spoke } from './geometry.ts';

describe('donutSegments', () => {
  const circumference = 100;

  test('shares sum to one and arcs fill the ring', () => {
    const segments = donutSegments([3, 1], circumference);
    expect(segments[0]?.share).toBeCloseTo(0.75);
    expect(segments[1]?.share).toBeCloseTo(0.25);
    expect(segments[0]!.dash + segments[1]!.dash).toBeCloseTo(circumference);
  });

  test('each segment starts where the last one ended', () => {
    const segments = donutSegments([2, 1, 1], circumference);
    expect(segments[0]?.offset).toBe(0);
    expect(segments[1]?.offset).toBeCloseTo(-50);
    expect(segments[2]?.offset).toBeCloseTo(-75);
  });

  test('dash and gap always make a whole circle, so nothing repeats', () => {
    for (const segment of donutSegments([5, 3, 2], circumference)) {
      expect(segment.dash + segment.gap).toBeCloseTo(circumference);
    }
  });

  test('all-zero values draw nothing rather than dividing by zero', () => {
    const segments = donutSegments([0, 0], circumference);
    expect(segments.every((segment) => segment.dash === 0 && segment.share === 0)).toBe(true);
    expect(segments.every((segment) => Number.isFinite(segment.offset))).toBe(true);
  });

  test('no values at all is an empty ring, not a crash', () => {
    expect(donutSegments([], circumference)).toEqual([]);
  });
});

describe('polar', () => {
  test('zero turns is twelve o’clock and a quarter turn is three', () => {
    const top = polar(0, 0, 10, 0);
    expect(top.x).toBeCloseTo(0);
    expect(top.y).toBeCloseTo(-10);

    const right = polar(0, 0, 10, 0.25);
    expect(right.x).toBeCloseTo(10);
    expect(right.y).toBeCloseTo(0);
  });
});

describe('spoke', () => {
  test('a full-height hour reaches the outer radius', () => {
    const line = spoke(0, 0, 10, 20, 0, 5, 5);
    expect(line.y1).toBeCloseTo(-10);
    expect(line.y2).toBeCloseTo(-20);
  });

  test('an empty hour collapses to the inner ring rather than vanishing', () => {
    const line = spoke(0, 0, 10, 20, 6, 0, 5);
    expect(line.x1).toBeCloseTo(line.x2);
    expect(line.y1).toBeCloseTo(line.y2);
  });

  test('a max of zero does not divide by zero', () => {
    const line = spoke(0, 0, 10, 20, 3, 0, 0);
    expect(Number.isFinite(line.x2)).toBe(true);
    expect(Number.isFinite(line.y2)).toBe(true);
  });
});

describe('columnHeights', () => {
  test('scales to the tallest column', () => {
    expect(columnHeights([10, 5, 0], 100)).toEqual([100, 50, 0]);
  });

  test('a day with almost nothing still draws', () => {
    // Rounding a single message to zero makes it indistinguishable from a day off, which
    // is the one distinction the chart exists to draw.
    const [, quiet] = columnHeights([1000, 1], 100);
    expect(quiet).toBeGreaterThan(0);
  });

  test('an empty range is all zeros, not NaN', () => {
    expect(columnHeights([0, 0], 100)).toEqual([0, 0]);
  });
});
