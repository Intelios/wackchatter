/**
 * Plotting the rating lines.
 *
 * Pure, and separate from the component, because there is no DOM test harness here — the
 * scaling is where a chart actually lies to you, so it is the part worth pinning.
 */

import type { RatingPoint, RatingSeries } from './elo.ts';
import { START_RATING } from './elo.ts';

export interface PlotBounds {
  min: number;
  max: number;
}

/**
 * The smallest rating band the chart will draw.
 *
 * Without a floor, three rounds of tiny movement would be stretched to fill the plot and a
 * sixteen-point gap would look like a rout. A fixed minimum span keeps early rounds looking
 * like what they are: barely anything yet.
 */
export const MIN_SPAN = 120;

/** Breathing room above and below the data, as a fraction of the span. */
const PADDING = 0.12;

/**
 * Which lines a focused chart draws.
 *
 * An empty focus draws everything. A focus that no longer matches anything — the per-card
 * filter changed under it — degrades to everything as well, because a blank plot would
 * read as "no history" rather than as "your selection is stale". Colours are the full
 * view's and are never re-assigned here, so a line keeps its corner colour through a focus.
 */
export function visibleSeries(
  series: readonly RatingSeries[],
  focus: ReadonlySet<string>,
): readonly RatingSeries[] {
  if (focus.size === 0) return series;
  const visible = series.filter((entry) => focus.has(entry.contenderId));
  return visible.length > 0 ? visible : series;
}

/**
 * The rating range to draw.
 *
 * Always includes the starting rating, so the 1500 guide line is on the chart and every
 * line can be read as "above or below where it began" without hunting for the axis.
 */
export function ratingBounds(series: readonly RatingSeries[]): PlotBounds {
  let min = START_RATING;
  let max = START_RATING;
  for (const entry of series) {
    for (const point of entry.points) {
      if (point.rating < min) min = point.rating;
      if (point.rating > max) max = point.rating;
    }
  }

  const span = Math.max(max - min, MIN_SPAN);
  const centre = (min + max) / 2;
  const half = span / 2 + span * PADDING;
  return { min: centre - half, max: centre + half };
}

/** Where a round index falls horizontally. A single round is drawn at the left edge. */
export function plotX(index: number, count: number, width: number): number {
  if (count <= 1) return 0;
  return (index / (count - 1)) * width;
}

/** Where a rating falls vertically. SVG y grows downward, so a higher rating is a lower y. */
export function plotY(rating: number, bounds: PlotBounds, height: number): number {
  const span = bounds.max - bounds.min;
  if (span <= 0) return height / 2;
  return height - ((rating - bounds.min) / span) * height;
}

/** One line, as an SVG `points` attribute. */
export function plotLine(
  points: readonly RatingPoint[],
  bounds: PlotBounds,
  width: number,
  height: number,
): string {
  return points
    .map(
      (point) =>
        `${plotX(point.index, points.length, width).toFixed(2)},${plotY(point.rating, bounds, height).toFixed(2)}`,
    )
    .join(' ');
}

/**
 * Which round index a pointer at `ratio` across the plot is nearest.
 *
 * Nearest rather than the one to the left: the readout should follow the point your eye is
 * on, and rounding down makes the last round unreachable at the right-hand edge.
 */
export function indexAt(ratio: number, count: number): number {
  if (count <= 1) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  return Math.round(clamped * (count - 1));
}
