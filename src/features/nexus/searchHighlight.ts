/**
 * Where a live search query lands in a memory's text.
 *
 * The explorer's filter is a plain case-insensitive substring test over the record's
 * text, cues and identity names, so the highlighter marks the same thing the filter
 * matched: the verbatim query, found with the same non-overlapping forward scan the card
 * sheet uses (`searchCard` in cardSearch.ts). Deliberately not the stemmed `matched`
 * terms `searchDocuments` computes for model recall — those are lemmas ("dragon" for a
 * query of "dragons"), and a lemma that is not present in the text cannot be marked.
 *
 * This is only the range finding; the rendering split is `highlightParts` from
 * cardSearch.ts, so both consumers cut text into runs the same way.
 */

/**
 * Below this a query highlights single characters everywhere and the marking is noise
 * rather than an answer. Same threshold as the card sheet's find box.
 */
export const MIN_HIGHLIGHT_QUERY = 2;

/** A hit, as a half-open range into the searched text. */
export interface TextMatchRange {
  start: number;
  end: number;
}

export function matchRanges(text: string, query: string): TextMatchRange[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < MIN_HIGHLIGHT_QUERY) return [];
  // The same normalisation the explorer's filter applies, so a range exists exactly
  // where the filter found its match.
  const haystack = text.toLocaleLowerCase();
  const ranges: TextMatchRange[] = [];
  // Non-overlapping, scanning forward: "aa" in "aaaa" is two hits, not three.
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    ranges.push({ start: at, end: at + needle.length });
  }
  return ranges;
}
