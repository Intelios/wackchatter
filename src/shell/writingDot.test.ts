import { describe, expect, test } from 'bun:test';
import {
  DOT_TRICK_SECONDS,
  DOT_TRICKS,
  type DotTrick,
  dotTrick,
  nextDotTrick,
  restingDot,
} from './writingDot.ts';

const R = 5;

/** Every shape is the plain dot: a round disc of radius R on the origin. */
function expectPlainDot(trick: DotTrick, t: number) {
  for (const shape of dotTrick(trick, t, R)) {
    expect(shape.kind).toBe('disc');
    if (shape.kind !== 'disc') continue;
    expect(shape.x).toBeCloseTo(0, 6);
    expect(shape.y).toBeCloseTo(0, 6);
    expect(shape.rx).toBeCloseTo(R, 6);
    expect(shape.ry).toBeCloseTo(R, 6);
  }
}

describe('dotTrick', () => {
  test('every trick starts and ends as the plain dot, so any one can follow any other', () => {
    for (const trick of DOT_TRICKS) {
      expectPlainDot(trick, 0);
      expectPlainDot(trick, 1);
    }
  });

  test('every trick does something in between, and has a length', () => {
    for (const trick of DOT_TRICKS) {
      const moved = [0.2, 0.35, 0.5, 0.65].some((t) =>
        dotTrick(trick, t, R).some(
          (s) =>
            s.kind !== 'disc' ||
            Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.rx - R) + Math.abs(s.ry - R) > 0.5,
        ),
      );
      expect(moved).toBe(true);
      expect(DOT_TRICK_SECONDS[trick]).toBeGreaterThan(0);
    }
  });

  test('stays inside the room the canvas gives it', () => {
    for (const trick of DOT_TRICKS) {
      for (let t = 0; t <= 1; t += 0.01) {
        for (const s of dotTrick(trick, t, R)) {
          if (s.kind === 'disc') {
            expect(s.x - s.rx).toBeGreaterThanOrEqual(-15);
            expect(s.x + s.rx).toBeLessThanOrEqual(29);
            expect(Math.abs(s.y) + s.ry).toBeLessThanOrEqual(20);
          } else if (s.kind === 'arc') {
            expect(s.radius + s.width / 2).toBeLessThanOrEqual(15);
          } else {
            expect(s.from + s.length).toBeLessThanOrEqual(15);
          }
        }
      }
    }
  });
});

describe('restingDot', () => {
  test('is the plain dot at the start of a breath', () => {
    expect(restingDot(0, R)).toEqual([{ kind: 'disc', x: 0, y: 0, rx: R, ry: R }]);
  });
});

describe('nextDotTrick', () => {
  test('never plays the same trick twice running, and reaches them all', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let previous: DotTrick | null = null;
    const seen = new Set<DotTrick>();
    for (let i = 0; i < 400; i++) {
      const trick = nextDotTrick(previous, random);
      expect(trick).not.toBe(previous);
      seen.add(trick);
      previous = trick;
    }
    expect(seen.size).toBe(DOT_TRICKS.length);
  });
});
