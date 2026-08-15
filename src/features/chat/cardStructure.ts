/**
 * Finding a card's own structure inside one of its text fields.
 *
 * Cards are written by hand, in no agreed format. Some use markdown headings, some a bare
 * `Appearance:` on its own line, some the bracketed PList and W++ dialects, and plenty are
 * one undivided paragraph. This module is the part that guesses, kept away from
 * `cardSheet.ts` so the composer never has to know which dialect won — it asks for a split
 * and gets one or `null`.
 *
 * `null` is the normal answer and costs the reader nothing: the composer falls back to the
 * card's own fields, which every card has by definition. That is the whole reason the
 * guessing lives behind a seam. A confident wrong index is the failure worth avoiding, so
 * every detector here is required to find at least TWO of its own kind before it claims a
 * structure — one heading is a false positive, not a shape.
 *
 * The detectors themselves land in a later phase. The seam exists now so the composer is
 * written once, against the API it will keep.
 */

/** How a field announced its sections. */
export type HeadingStyle = 'markdown' | 'xml' | 'bracket' | 'colon';
export type GroupStyle = 'plist' | 'wpp';
export type SplitStyle = HeadingStyle | GroupStyle;

/** One section's label and the half-open range of the field text it owns. */
export interface SplitPart {
  label: string;
  start: number;
  end: number;
}

export interface FieldSplit {
  style: SplitStyle;
  /**
   * In source order, and an exact partition: the parts' ranges are contiguous, start at 0
   * and end at the field's length. Slicing them all and joining returns the field text
   * unchanged, which is what makes "nothing is ever hidden from the reader" a property of
   * the data rather than a promise about the UI.
   */
  parts: SplitPart[];
}

/**
 * Split a field into its own sections, or `null` when it has none worth showing.
 *
 * Headings are tried before groups: a card carrying both is far more likely to be prose
 * under headings that happens to mention a bracketed list than the reverse.
 */
export function splitCardText(_text: string): FieldSplit | null {
  // Rungs 1 and 2 land in a later phase. Until then every card reads at the field rung,
  // which is the rung that cannot fail.
  return null;
}
