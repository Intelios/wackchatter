import { describe, expect, test } from 'bun:test';
import { START_RATING } from './elo.ts';
import { ratingTone, TONE_FULL_ABOVE, TONE_FULL_BELOW } from './ratingTone.ts';

describe('ratingTone', () => {
  test('the starting rating is level — the one value that means nothing yet', () => {
    expect(ratingTone(START_RATING)).toEqual({ kind: 'level', strength: 0 });
  });

  test('above the start, strength climbs linearly toward the pure-colour point', () => {
    expect(ratingTone(START_RATING + 10)).toMatchObject({ kind: 'above' });
    expect(ratingTone(START_RATING + 10).strength).toBeCloseTo(0.1);
    expect(ratingTone(START_RATING + 50).strength).toBeCloseTo(0.5);
  });

  test('below the start, strength climbs linearly toward the pure-colour point', () => {
    expect(ratingTone(START_RATING - 25)).toMatchObject({ kind: 'below' });
    expect(ratingTone(START_RATING - 25).strength).toBeCloseTo(0.1);
    expect(ratingTone(START_RATING - 125).strength).toBeCloseTo(0.5);
  });

  test('the ramps saturate at the clamp points and never exceed them', () => {
    expect(ratingTone(TONE_FULL_ABOVE)).toEqual({ kind: 'above', strength: 1 });
    expect(ratingTone(TONE_FULL_ABOVE + 300)).toEqual({ kind: 'above', strength: 1 });
    expect(ratingTone(TONE_FULL_BELOW)).toEqual({ kind: 'below', strength: 1 });
    expect(ratingTone(TONE_FULL_BELOW - 300)).toEqual({ kind: 'below', strength: 1 });
  });

  test('the clamp points are the values the scale is explained with', () => {
    // 1600 is pure green, 1250 is pure red. A different span would still "work" but would
    // make every number on the board lie about how strong a colour means.
    expect(TONE_FULL_ABOVE).toBe(START_RATING + 100);
    expect(TONE_FULL_BELOW).toBe(START_RATING - 250);
  });
});
