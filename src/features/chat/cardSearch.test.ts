import { describe, expect, test } from 'bun:test';
import { firstHitSection, highlightParts, matchesIn, searchCard } from './cardSearch.ts';
import type { CardSection } from './cardSheet.ts';

function section(id: string, label: string, text: string): CardSection {
  return { id, label, text, source: { kind: 'field', field: 'description' } };
}

const SECTIONS: CardSection[] = [
  section('field:description', 'Description', 'Her raven-black hair falls in twin tails.'),
  section(
    'field:personality',
    'Personality',
    'Fiercely private. She hates having her hair touched.',
  ),
  section('field:scenario', 'Scenario', 'The supply boat is three weeks late.'),
];

describe('searching a card', () => {
  test('hits are counted per section and found in every one', () => {
    const search = searchCard(SECTIONS, 'hair');

    expect(search.matches).toHaveLength(2);
    expect(search.counts.get('field:description')).toBe(1);
    expect(search.counts.get('field:personality')).toBe(1);
    expect(search.counts.has('field:scenario')).toBe(false);
  });

  test('matching ignores case', () => {
    expect(searchCard(SECTIONS, 'RAVEN').matches).toHaveLength(1);
  });

  /* One character matches half the card, which is noise rather than an answer — and it
     would repaint every section on the first keystroke of every word. */
  test('a one-character query matches nothing', () => {
    expect(searchCard(SECTIONS, 'h').matches).toEqual([]);
    expect(searchCard(SECTIONS, '  ').query).toBe('');
  });

  /* Cards are full of brackets and asterisks. Someone typing "(" means the character. */
  test('regex metacharacters are literal, not a pattern', () => {
    const bracketed = [section('a', 'A', 'She is [tall] and (quiet) — .* is not a wildcard.')];

    expect(searchCard(bracketed, '[tall]').matches).toHaveLength(1);
    expect(searchCard(bracketed, '.*').matches).toHaveLength(1);
    expect(searchCard(bracketed, '(quiet)').matches).toHaveLength(1);
  });

  test('repeats are counted without overlapping themselves', () => {
    const repeated = [section('a', 'A', 'aaaa')];

    expect(searchCard(repeated, 'aa').counts.get('a')).toBe(2);
  });

  /* A chip named Personality must not look dead when you search "personality" — but its
     text has no hits, so the count and the label match are kept apart. */
  test('a label match is recorded separately from text hits', () => {
    const search = searchCard(SECTIONS, 'scenario');

    expect(search.labelled.has('field:scenario')).toBe(true);
    expect(search.counts.has('field:scenario')).toBe(false);
  });

  test('matches can be taken one section at a time', () => {
    expect(matchesIn(searchCard(SECTIONS, 'hair'), 'field:personality')).toHaveLength(1);
  });
});

describe('deciding whether to jump', () => {
  test('a query with no hits in the open section jumps to the first that has one', () => {
    const search = searchCard(SECTIONS, 'boat');

    expect(firstHitSection(search, 'field:description')).toBe('field:scenario');
  });

  /* Being moved off a section you deliberately opened is worse than looking at one that
     happens to have no hits. */
  test('a section that already has hits is left alone', () => {
    expect(firstHitSection(searchCard(SECTIONS, 'hair'), 'field:personality')).toBeNull();
  });

  test('a query that matches nothing moves nothing', () => {
    expect(firstHitSection(searchCard(SECTIONS, 'lighthouse'), 'field:description')).toBeNull();
  });
});

describe('cutting text into highlighted runs', () => {
  const text = 'Her raven-black hair falls in twin tails.';

  test('every character survives the cut', () => {
    const parts = highlightParts(
      text,
      matchesIn(searchCard(SECTIONS, 'hair'), 'field:description'),
    );

    expect(parts.map((part) => part.text).join('')).toBe(text);
  });

  test('the matched run is the one marked', () => {
    const parts = highlightParts(text, [{ start: 16, end: 20 }]);

    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(['hair']);
  });

  test('no part is ever empty, so the view needs no guard', () => {
    for (const matches of [[{ start: 0, end: 3 }], [{ start: 37, end: 40 }], []]) {
      expect(highlightParts(text, matches).every((part) => part.text.length > 0)).toBe(true);
    }
  });

  test('text with no matches comes back whole and unmarked', () => {
    expect(highlightParts(text, [])).toEqual([{ text, hit: false }]);
  });

  test('empty text yields no parts at all', () => {
    expect(highlightParts('', [])).toEqual([]);
  });

  /* A caller handing over a tangle must not be able to duplicate text on screen. */
  test('overlapping ranges are clipped rather than repeated', () => {
    const parts = highlightParts('abcdef', [
      { start: 1, end: 4 },
      { start: 2, end: 5 },
    ]);

    expect(parts.map((part) => part.text).join('')).toBe('abcdef');
  });

  test('unsorted ranges are put back in order', () => {
    const parts = highlightParts('abcdef', [
      { start: 4, end: 5 },
      { start: 0, end: 1 },
    ]);

    expect(parts.map((part) => part.text).join('')).toBe('abcdef');
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(['a', 'e']);
  });

  test('a range running past the end is clipped to it', () => {
    expect(
      highlightParts('abc', [{ start: 1, end: 99 }])
        .map((part) => part.text)
        .join(''),
    ).toBe('abc');
  });
});
