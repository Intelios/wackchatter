export interface Camera {
  x: number;
  y: number;
  z: number;
}

export const VIEW_W = 1000;
export const VIEW_H = 700;

/** Matches the wheel and button zoom limits; fit must not exceed what they can undo. */
export const Z_MIN = 0.15;
export const Z_MAX = 4;

/** Fraction of the rendered element the fitted content may occupy. */
const MARGIN = 0.9;

/**
 * Fits the camera to the given positions so they fill the rendered element,
 * not the letterboxed viewBox: `preserveAspectRatio="xMidYMid meet"` scales the
 * 1000×700 box by min(w/1000, h/700), so a tall pane shows the same box smaller
 * and a fit aimed at 1000×700 leaves most of its height empty.
 */
export function fitCamera(
  points: readonly { x: number; y: number }[],
  viewport: { width: number; height: number },
): Camera {
  if (!points.length) return { x: 0, y: 0, z: 1 };
  const width = viewport.width > 0 ? viewport.width : VIEW_W;
  const height = viewport.height > 0 ? viewport.height : VIEW_H;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // A single node has no extent; floor the span so the zoom maths stays finite.
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min(width / VIEW_W, height / VIEW_H);
  const z = Math.max(
    Z_MIN,
    Math.min(
      Z_MAX,
      Math.min((MARGIN * width) / (spanX * scale), (MARGIN * height) / (spanY * scale)),
    ),
  );
  return {
    z,
    x: VIEW_W / 2 - ((minX + maxX) / 2) * z,
    y: VIEW_H / 2 - ((minY + maxY) / 2) * z,
  };
}
