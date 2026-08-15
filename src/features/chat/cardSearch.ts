/**
 * Finding a word inside a card.
 *
 * The sheet's sections answer "where would that be written down"; this answers "just tell
 * me where it says hair". It is the band that works on every card ever written, including
 * the ones `cardStructure.ts` can make no sense of at all, which is why it sits at the top
 * of the sheet rather than behind a disclosure.
 *
 * Plain `indexOf` over lowercased text, deliberately — no regex. A card is full of
 * brackets, asterisks and parentheses, and a user typing `(` into a find box means the
 * character, not a capture group. Escaping a pattern is the usual fix and this is the
 * simpler one: there is no pattern to escape.
 *
 * Offsets are into the section's own text, which is the same string the view renders while
 * a query is live. That is what keeps the counts on the chips and the marks in the prose
 * from ever disagreeing — one offset space, one source of truth.
 */

import type { CardSection } from './cardSheet.ts';

/**
 * Below this a query matches half the card and the highlighting is noise rather than an
 * answer. Two also keeps the first keystroke of a word from repainting every section.
 */
const MIN_QUERY = 2;

/** A hit, as a half-open range into `sections[i].text`. */
export interface CardMatch {
  sectionId: string;
  start: number;
  end: number;
}

export interface CardSearch {
  /** Trimmed. Empty when the query was too short to run. */
  query: string;
  /** Every hit, in section order then source order. */
  matches: CardMatch[];
  /** Section id to hit count, for the chips. Absent means zero. */
  counts: ReadonlyMap<string, number>;
  /**
   * Sections whose *label* matches, kept apart from `counts` so the two never blur. A chip
   * named Personality should not look dead when you search "personality", even though the
   * hits are in its name rather than its text.
   */
  labelled: ReadonlySet<string>;
}

const EMPTY: CardSearch = {
  query: '',
  matches: [],
  counts: new Map(),
  labelled: new Set(),
};

export function searchCard(sections: readonly CardSection[], query: string): CardSearch {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY) return EMPTY;

  const needle = trimmed.toLowerCase();
  const matches: CardMatch[] = [];
  const counts = new Map<string, number>();
  const labelled = new Set<string>();

  for (const section of sections) {
    if (section.label.toLowerCase().includes(needle)) labelled.add(section.id);

    const haystack = section.text.toLowerCase();
    let count = 0;
    // Non-overlapping, scanning forward: "aa" in "aaaa" is two hits, not three.
    for (
      let at = haystack.indexOf(needle);
      at !== -1;
      at = haystack.indexOf(needle, at + needle.length)
    ) {
      matches.push({ sectionId: section.id, start: at, end: at + needle.length });
      count++;
    }
    if (count > 0) counts.set(section.id, count);
  }

  return { query: trimmed, matches, counts, labelled };
}

/** Hits belonging to one section, ready for `highlightParts`. */
export function matchesIn(search: CardSearch, sectionId: string): CardMatch[] {
  return search.matches.filter((match) => match.sectionId === sectionId);
}

/**
 * The section a query should jump to, or null when it is already showing one with hits.
 *
 * Only the query changing calls this. A chip the reader clicked always wins — being moved
 * off a section you deliberately opened is worse than looking at one with no hits in it.
 */
export function firstHitSection(search: CardSearch, openId: string): string | null {
  if (search.matches.length === 0) return null;
  if (search.counts.has(openId)) return null;
  return search.matches[0]?.sectionId ?? null;
}

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/**
 * Cut `text` into alternating plain and matched runs.
 *
 * Every character survives — `parts.map(p => p.text).join('') === text` — and no part is
 * ever empty, so the view can render the list without guarding either case. Ranges are
 * sorted and any that overlap one already taken is dropped, so a caller cannot produce
 * duplicated text by handing over a tangle.
 */
export function highlightParts(
  text: string,
  matches: readonly { start: number; end: number }[],
): HighlightPart[] {
  const parts: HighlightPart[] = [];
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  let cursor = 0;

  for (const match of ordered) {
    const start = Math.max(match.start, cursor);
    const end = Math.min(match.end, text.length);
    if (end <= start) continue;

    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}
