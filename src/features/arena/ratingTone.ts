/**
 * The colour tone of a displayed rating.
 *
 * A rating is a distance from the start, and the number alone makes the reader compute that
 * distance for every row. The tint spares them the arithmetic: green above, amber sinking to
 * red below, and the further from 1500 the stronger the colour — a 1510 is a faint green,
 * a 1600 is a pure one.
 *
 * The scale is FIXED, not fitted to the board. Fitting would paint the top entrant pure
 * green however meaningless a 1520 lead still is, which is exactly the exaggeration the
 * bar axis refuses with its own fixed span — see `AXIS_SPAN` in Leaderboard.
 *
 * Pure: it returns the kind and a 0–1 strength, and CSS shapes the colour from tokens.
 * Provisional ratings get no tone at all — see the caller.
 */

import { START_RATING } from './elo.ts';

/** Where the upward ramp becomes pure green. */
export const TONE_FULL_ABOVE = START_RATING + 100;

/** Where the downward ramp becomes pure red. */
export const TONE_FULL_BELOW = START_RATING - 250;

export type RatingToneKind = 'level' | 'above' | 'below';

export interface RatingTone {
  kind: RatingToneKind;
  /** 0 at the starting rating, 1 at and beyond the pure-colour point. Linear between. */
  strength: number;
}

export function ratingTone(rating: number): RatingTone {
  if (rating > START_RATING) {
    return {
      kind: 'above',
      strength: Math.min(1, (rating - START_RATING) / (TONE_FULL_ABOVE - START_RATING)),
    };
  }
  if (rating < START_RATING) {
    return {
      kind: 'below',
      strength: Math.min(1, (START_RATING - rating) / (START_RATING - TONE_FULL_BELOW)),
    };
  }
  return { kind: 'level', strength: 0 };
}
