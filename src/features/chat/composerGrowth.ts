/**
 * How tall the composer's input is allowed to get.
 *
 * Pure and separate from the component for the reason the rest of the app splits logic out:
 * there is no DOM test harness, so arithmetic that matters has to leave the React file to be
 * pinned. Everything here takes measurements as arguments — nothing in this module reads the
 * document.
 *
 * Two ceilings, and the lower wins. The row cap is a fixed pixel height derived from the type
 * scale; the viewport share is what stops the composer overhanging the bottom edge on a short
 * window — a laptop with a browser bar, a phone with the keyboard up. Past whichever is lower,
 * the textarea scrolls internally.
 */

/** Rows of text before the input stops growing and starts scrolling. */
export const MAX_ROWS = 16;

/**
 * The composer's share of the window, as a hard ceiling.
 *
 * A flex item that cannot shrink simply overhangs the bottom edge — that is the composer
 * "slipping off screen" — so the input is capped well short of the window it lives in.
 */
export const MAX_VIEWPORT_SHARE = 0.45;

export interface RowCapInput {
  /** The input's computed line height, in px. */
  lineHeight: number;
  /** Its padding-top plus padding-bottom. */
  verticalPadding: number;
  /** Its two border widths. */
  verticalBorders: number;
  maxRows?: number;
}

/** The fixed ceiling: `maxRows` line boxes, plus the box's own vertical furniture. */
export function rowCap({
  lineHeight,
  verticalPadding,
  verticalBorders,
  maxRows = MAX_ROWS,
}: RowCapInput): number {
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return Number.POSITIVE_INFINITY;
  return lineHeight * maxRows + verticalPadding + verticalBorders;
}

export interface ComposerMaxHeightInput {
  /** The fixed ceiling from `rowCap`. May be Infinity when the line height is unreadable. */
  rowCap: number;
  /** The height the composer actually has to fit inside — the visual viewport where there is one. */
  viewportHeight: number;
  /**
   * Everything in the composer that is NOT the input: the tray and the gap above it.
   *
   * This is the whole reason this function exists. The viewport share is a budget for the
   * *composer*, but it used to be spent on the *input* alone — which was the same thing only
   * while the input was the composer's only row. With a tray beneath it, charging the share to
   * the input lets the composer reach its share plus the tray's height, and the ceiling stops
   * meaning what its comment says it means.
   *
   * Measured by the caller rather than named as a constant here: it is a sum of tokens
   * (`--wc-control`, the row gap) and a constant would drift silently the first time one moved.
   */
  trayBlock: number;
  /**
   * One row of the input. The floor.
   *
   * Without it a short enough window — or a large enough tray — computes a ceiling below a
   * single line, and the input collapses to nothing at the moment it is most needed. A composer
   * that overhangs slightly is recoverable; one you cannot see what you typed in is not.
   */
  rowHeight: number;
}

export function composerMaxHeight({
  rowCap: cap,
  viewportHeight,
  trayBlock,
  rowHeight,
}: ComposerMaxHeightInput): number {
  // No usable viewport measurement — before first layout, or in a detached document. The fixed
  // ceiling is the honest answer: it is the one that does not depend on the window.
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return Number.isFinite(cap) ? Math.max(rowHeight, cap) : rowHeight;
  }

  const budget = viewportHeight * MAX_VIEWPORT_SHARE - Math.max(0, trayBlock);
  return Math.max(rowHeight, Math.min(cap, budget));
}
