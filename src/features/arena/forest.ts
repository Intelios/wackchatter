/**
 * Geometry for the forest plot.
 *
 * Pure, and separate from the component, for the same reason `chart.ts` is: there is no DOM
 * test harness here, and the scale is where a chart lies to you. The x-scale is shared by
 * every row — one contender's whisker must be comparable with any other's — so the bounds
 * consider the whole board at once, never one row at a time.
 */

import type { LeaderboardRow } from './elo.ts';
import { START_RATING } from './elo.ts';
import type { RatingInterval } from './intervals.ts';

export interface ForestBounds {
  min: number;
  max: number;
}

/**
 * The smallest rating band the plot will draw.
 *
 * Without a floor, a first sitting of ±20-point bands would be stretched across the whole
 * width and a lucky sixteen-point lead would look like a rout. Same value and same
 * reasoning as the trend chart's `MIN_SPAN`, so the two views of one board exaggerate
 * alike.
 */
export const FOREST_MIN_SPAN = 120;

/** Breathing room either side of the data, as a fraction of the span. */
const PADDING = 0.12;

/**
 * The rating range to draw.
 *
 * Always includes the starting rating, so the 1500 guide line is on the axis and every band
 * reads as "above or below where it began" without hunting. Interval ends are considered
 * alongside the ratings themselves because nothing clamps the dot into its band — a tiny
 * history can leave the point at the very end, and the axis must have room to say so.
 */
export function forestBounds(
  rows: readonly LeaderboardRow[],
  intervals: ReadonlyMap<string, RatingInterval>,
): ForestBounds {
  let min = START_RATING;
  let max = START_RATING;

  for (const row of rows) {
    if (row.rating < min) min = row.rating;
    if (row.rating > max) max = row.rating;

    const interval = intervals.get(row.contenderId);
    if (interval) {
      if (interval.low < min) min = interval.low;
      if (interval.high > max) max = interval.high;
    }
  }

  const span = Math.max(max - min, FOREST_MIN_SPAN);
  const centre = (min + max) / 2;
  const half = span / 2 + span * PADDING;
  return { min: centre - half, max: centre + half };
}

/** Where a rating falls across the plot, as a percentage of its width. */
export function forestPercent(rating: number, bounds: ForestBounds): number {
  const span = bounds.max - bounds.min;
  if (span <= 0) return 50;
  return ((rating - bounds.min) / span) * 100;
}
