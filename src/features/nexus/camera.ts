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

/** Fraction of the rendered element the fitted content may occupy. Below the old 0.9:
 *  on the full-bleed map a 90% fit read as "zoomed in", and the constellation needs
 *  dark space around it more than it needs size. */
const MARGIN = 0.8;

/**
 * The drawn node is wider than its centre point: a halo above, and the name
 * label hanging ~50 units below. The fit bounds the centres, so it must make
 * room for the extents or the lowest node's label lands off the canvas.
 */
export const PAD = { top: 30, bottom: 60, x: 50 };

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
  const spanX = Math.max(maxX - minX + 2 * PAD.x, 1);
  const spanY = Math.max(maxY - minY + PAD.top + PAD.bottom, 1);
  const scale = Math.min(width / VIEW_W, height / VIEW_H);
  const z = Math.max(
    Z_MIN,
    Math.min(
      Z_MAX,
      Math.min((MARGIN * width) / (spanX * scale), (MARGIN * height) / (spanY * scale)),
    ),
  );
  // Centre the padded box, not the bare points: the label skirt is part of
  // the content, so the cluster sits slightly high of centre on purpose.
  const cy = (minY - PAD.top + maxY + PAD.bottom) / 2;
  return { z, x: VIEW_W / 2 - ((minX + maxX) / 2) * z, y: VIEW_H / 2 - cy * z };
}

/**
 * Projects a point in map space to pixel coordinates in the rendered element.
 *
 * The SVG viewBox is letterboxed onto its element (`xMidYMid meet`), so the map is
 * offset inside the element by half the slack on each axis before the camera transform
 * is applied. The node card and anything else HTML-side that must hug a map feature
 * anchors through this; the drag handler is the same maths run backwards.
 */
export function screenPoint(
  p: { x: number; y: number },
  camera: Camera,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const scale = Math.min(viewport.width / VIEW_W, viewport.height / VIEW_H);
  const ox = (viewport.width - VIEW_W * scale) / 2;
  const oy = (viewport.height - VIEW_H * scale) / 2;
  return {
    x: ox + (p.x * camera.z + camera.x) * scale,
    y: oy + (p.y * camera.z + camera.y) * scale,
  };
}
