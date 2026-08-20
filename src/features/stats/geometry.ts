/**
 * Chart geometry.
 *
 * Pure, because there is no DOM test harness — the arithmetic that decides where a segment
 * lands is testable, and the components that consume it stay thin enough not to need one.
 */

export interface DonutSegment {
  /** `stroke-dasharray` first value: the drawn arc. */
  dash: number;
  /** `stroke-dasharray` second value: the rest of the circle. */
  gap: number;
  /** `stroke-dashoffset`. Negative, because offset winds the pattern backwards. */
  offset: number;
  /** Share of the whole, 0–1. */
  share: number;
}

export const TAU = Math.PI * 2;

/**
 * Lay values around a circle as dash patterns.
 *
 * One ring per segment, stacked, rather than one path with several strokes: a browser draws
 * a dashed stroke from the same start point every time, so the offset is what separates
 * them, and each ring can then animate its own sweep.
 */
export function donutSegments(values: readonly number[], circumference: number): DonutSegment[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return values.map(() => ({ dash: 0, gap: circumference, offset: 0, share: 0 }));

  let consumed = 0;
  return values.map((value) => {
    const share = Math.max(0, value) / total;
    const dash = share * circumference;
    // Normalised: negating zero gives -0, which is a surprising thing to find in a
    // snapshot even though it serialises into the attribute as "0".
    const offset = consumed === 0 ? 0 : -consumed;
    consumed += dash;
    return { dash, gap: circumference - dash, offset, share };
  });
}

export interface Point {
  x: number;
  y: number;
}

/** Twelve o'clock is zero and the angle runs clockwise, as a clock face is read. */
export function polar(cx: number, cy: number, radius: number, turns: number): Point {
  const angle = turns * TAU - Math.PI / 2;
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

export interface Spoke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * One spoke of the hour dial. Length is proportional to the count, from `inner` outwards,
 * so an empty hour is a tick rather than a gap — the ring should stay legible as a clock
 * even where nothing happened.
 */
export function spoke(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  index: number,
  count: number,
  max: number,
): Spoke {
  const turns = index / 24;
  const share = max > 0 ? Math.max(0, count) / max : 0;
  const start = polar(cx, cy, inner, turns);
  const end = polar(cx, cy, inner + (outer - inner) * share, turns);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/**
 * Column heights in a fixed plot height, scaled to the tallest bar.
 *
 * A non-zero day always gets at least a sliver: a day with one message rounding to nothing
 * is indistinguishable from a day with none, and the difference is the whole point of the
 * chart.
 */
export function columnHeights(values: readonly number[], height: number, minimum = 2): number[] {
  const max = values.reduce((best, value) => Math.max(best, value), 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((value) =>
    value <= 0 ? 0 : Math.max(minimum, Math.round((value / max) * height)),
  );
}
