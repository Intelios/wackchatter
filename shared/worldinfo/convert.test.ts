import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
// Test-only reach into server/. The purity rule is about what ships to the browser;
// re-implementing a PNG walk here just to keep the import graph tidy would mean the gate
// test depended on a second, untested decoder.
import { readCard } from '../../server/lib/card.ts';
import type { CharacterBook } from '../types/card.ts';
import type { WorldInfoBook } from '../types/worldinfo.ts';
import { WI_LOGIC, WI_POSITION, WI_ROLE, createWorldInfoEntry } from '../types/worldinfo.ts';
import {
  bookEntries,
  nextUid,
  normalizeBook,
  removeEntry,
  toCharacterBook,
  toWorldInfoBook,
} from './convert.ts';

/**
 * Seraphina ships with SillyTavern and carries a real 4-entry embedded lorebook. It is
 * the gate: if her book survives a round-trip through our internal shape, the field
 * mapping is right.
 */
const SERAPHINA_PATH =
  '/Users/jack/Documents/GitHub/SillyTavernSource/default/content/default_Seraphina.png';

function seraphinaBook(): CharacterBook {
  const card = readCard(new Uint8Array(readFileSync(SERAPHINA_PATH)));
  const book = card.data.character_book;
  if (!book) throw new Error('Seraphina has no embedded lorebook');
  return book;
}

/** A book with one entry carrying every field we map, plus keys nothing knows about. */
function richBook(): CharacterBook {
  return {
    name: 'Rich',
    description: 'a book',
    scan_depth: 3,
    token_budget: 500,
    recursive_scanning: true,
    extensions: { vendor_book_key: 'kept' },
    entries: [
      {
        id: 7,
        keys: ['castle', '/dragon(s)?/i'],
        secondary_keys: ['night'],
        comment: 'The castle',
        content: 'A tall castle.',
        constant: false,
        selective: true,
        insertion_order: 42,
        enabled: true,
        position: 'after_char',
        use_regex: true,
        // Unknown TOP-LEVEL keys — not covered by the extensions bag.
        priority: 9,
        name: 'castle-entry',
        vendor_top_level: 'kept too',
        extensions: {
          position: WI_POSITION.atDepth,
          exclude_recursion: true,
          prevent_recursion: false,
          delay_until_recursion: 2,
          display_index: 3,
          probability: 65,
          useProbability: true,
          depth: 6,
          selectiveLogic: WI_LOGIC.AND_ALL,
          outlet_name: 'sidebar',
          group: 'places',
          group_override: true,
          group_weight: 250,
          scan_depth: 5,
          case_sensitive: true,
          match_whole_words: false,
          use_group_scoring: true,
          automation_id: 'auto-1',
          role: WI_ROLE.USER,
          vectorized: false,
          sticky: 3,
          cooldown: 4,
          delay: 5,
          triggers: ['normal'],
          ignore_budget: true,
          // Things ST models and we deliberately don't.
          character_filter: { names: ['Seraphina'], tags: [], isExclude: true },
          match_persona_description: true,
          // A third-party key.
          vendor_extension_key: { nested: true },
        },
      },
    ],
  };
}

describe('toWorldInfoBook', () => {
  test('maps every extension key ST writes', () => {
    const entry = toWorldInfoBook(richBook()).entries['7'];
    if (!entry) throw new Error('uid 7 missing');

    expect(entry.key).toEqual(['castle', '/dragon(s)?/i']);
    expect(entry.keysecondary).toEqual(['night']);
    expect(entry.order).toBe(42);
    expect(entry.disable).toBe(false);
    // The extension wins over the degraded top-level 'after_char'.
    expect(entry.position).toBe(WI_POSITION.atDepth);
    expect(entry.displayIndex).toBe(3);
    expect(entry.excludeRecursion).toBe(true);
    expect(entry.delayUntilRecursion).toBe(2);
    expect(entry.probability).toBe(65);
    expect(entry.useProbability).toBe(true);
    expect(entry.depth).toBe(6);
    expect(entry.selectiveLogic).toBe(WI_LOGIC.AND_ALL);
    expect(entry.outletName).toBe('sidebar');
    expect(entry.group).toBe('places');
    expect(entry.groupOverride).toBe(true);
    expect(entry.groupWeight).toBe(250);
    expect(entry.scanDepth).toBe(5);
    expect(entry.caseSensitive).toBe(true);
    expect(entry.matchWholeWords).toBe(false);
    expect(entry.useGroupScoring).toBe(true);
    expect(entry.automationId).toBe('auto-1');
    expect(entry.role).toBe(WI_ROLE.USER);
    expect(entry.sticky).toBe(3);
    expect(entry.cooldown).toBe(4);
    expect(entry.delay).toBe(5);
    expect(entry.ignoreBudget).toBe(true);
    expect(entry.triggers).toEqual(['normal']);
  });

  test('falls back to the top-level position when there is no extension', () => {
    const book = richBook();
    book.entries[0]!.extensions = {};
    book.entries[0]!.position = 'before_char';
    expect(toWorldInfoBook(book).entries['7']?.position).toBe(WI_POSITION.before);

    book.entries[0]!.position = 'after_char';
    expect(toWorldInfoBook(book).entries['7']?.position).toBe(WI_POSITION.after);
  });

  test('does not mutate its input', () => {
    const book = richBook();
    const before = structuredClone(book);
    toWorldInfoBook(book);
    expect(book).toEqual(before);
  });

  test('reassigns duplicate ids rather than overwriting in the Record', () => {
    const book = richBook();
    book.entries.push({ ...book.entries[0]!, content: 'second' });

    const converted = toWorldInfoBook(book);
    const entries = Object.values(converted.entries);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.uid)).size).toBe(2);
    expect(entries.map((e) => e.content).sort()).toEqual(['A tall castle.', 'second']);
  });

  test('assigns a uid to an entry that has no id', () => {
    const book = richBook();
    const { id: _id, ...withoutId } = book.entries[0]!;
    book.entries = [withoutId as never];

    const entries = Object.values(toWorldInfoBook(book).entries);
    expect(entries).toHaveLength(1);
    expect(Number.isInteger(entries[0]!.uid)).toBe(true);
  });
});

describe('toCharacterBook', () => {
  test('round-trips every mapped field', () => {
    const original = richBook();
    const rebuilt = toCharacterBook(toWorldInfoBook(original), 'Rich');

    expect(rebuilt.entries).toHaveLength(1);
    const entry = rebuilt.entries[0]!;
    const ext = entry.extensions;

    expect(entry.keys).toEqual(['castle', '/dragon(s)?/i']);
    expect(entry.secondary_keys).toEqual(['night']);
    expect(entry.insertion_order).toBe(42);
    expect(entry.enabled).toBe(true);
    expect(ext.position).toBe(WI_POSITION.atDepth);
    expect(ext.display_index).toBe(3);
    expect(ext.probability).toBe(65);
    expect(ext.useProbability).toBe(true);
    expect(ext.selectiveLogic).toBe(WI_LOGIC.AND_ALL);
    expect(ext.group_weight).toBe(250);
    expect(ext.scan_depth).toBe(5);
    expect(ext.match_whole_words).toBe(false);
    expect(ext.role).toBe(WI_ROLE.USER);
    expect(ext.ignore_budget).toBe(true);
  });

  test('carries unknown extension keys and unknown top-level keys through', () => {
    const rebuilt = toCharacterBook(toWorldInfoBook(richBook()), 'Rich');
    const entry = rebuilt.entries[0]!;

    expect(entry.extensions.vendor_extension_key).toEqual({ nested: true });
    // ST models these; we do not. They must survive anyway.
    expect(entry.extensions.character_filter).toEqual({
      names: ['Seraphina'],
      tags: [],
      isExclude: true,
    });
    expect(entry.extensions.match_persona_description).toBe(true);

    // Only reachable via originalData — the extensions bag doesn't cover top level.
    expect(entry.priority).toBe(9);
    expect(entry.name).toBe('castle-entry');
    expect(entry.vendor_top_level).toBe('kept too');

    expect(rebuilt.extensions.vendor_book_key).toBe('kept');
  });

  test('degrades position at the top level exactly as ST does', () => {
    const rebuilt = toCharacterBook(toWorldInfoBook(richBook()), 'Rich');
    // atDepth is non-zero, so the top-level field says after_char and the real value
    // lives in extensions. Lossy on purpose — this is what ST writes.
    expect(rebuilt.entries[0]!.position).toBe('after_char');
    expect(rebuilt.entries[0]!.extensions.position).toBe(WI_POSITION.atDepth);
  });

  test('writes use_regex unconditionally, and read ignores it', () => {
    const book = toWorldInfoBook(richBook());
    const rebuilt = toCharacterBook(book, 'Rich');
    expect(rebuilt.entries[0]!.use_regex).toBe(true);

    // A plain key stays plain even with use_regex set — the literal decides, not the flag.
    const reread = toWorldInfoBook(rebuilt);
    expect(reread.entries['7']?.key).toEqual(['castle', '/dragon(s)?/i']);
  });

  test('never emits originalData into a character_book', () => {
    const rebuilt = toCharacterBook(toWorldInfoBook(richBook()), 'Rich');
    expect(rebuilt).not.toHaveProperty('originalData');
    expect(rebuilt.entries[0]).not.toHaveProperty('originalData');
  });

  test('always emits extensions, even when empty', () => {
    const book: WorldInfoBook = { name: 'Empty', entries: {} };
    const rebuilt = toCharacterBook(book, 'Empty');
    expect(rebuilt.extensions).toEqual({});
    expect(Object.hasOwn(rebuilt, 'extensions')).toBe(true);
  });

  test('a deleted entry does not leave its top-level keys behind', () => {
    const book = removeEntry(toWorldInfoBook(richBook()), 7);
    const rebuilt = toCharacterBook(book, 'Rich');
    expect(rebuilt.entries).toHaveLength(0);
  });
});

describe('Seraphina round-trip', () => {
  test('her embedded book survives conversion in both directions', () => {
    const original = seraphinaBook();
    const converted = toWorldInfoBook(original);

    expect(Object.keys(converted.entries).length).toBe(original.entries.length);

    const rebuilt = toCharacterBook(converted, original.name ?? 'Seraphina');
    expect(rebuilt.entries).toHaveLength(original.entries.length);

    // Every key ST's own writer emits must match what was there, field by field.
    original.entries.forEach((before, index) => {
      const after = rebuilt.entries[index]!;
      expect(after.keys).toEqual(before.keys);
      expect(after.content).toBe(before.content);
      expect(after.enabled).toBe(before.enabled);
      expect(after.insertion_order).toBe(before.insertion_order);
      expect(after.constant).toBe(before.constant ?? false);
      // Every extension key that was there is still there, with the same value.
      for (const [key, value] of Object.entries(before.extensions ?? {})) {
        expect(after.extensions[key]).toEqual(value);
      }
    });
  });
});

describe('normalizeBook', () => {
  test('fills defaults for a sparse standalone entry', () => {
    const book = normalizeBook({ name: 'Sparse', entries: { '0': { uid: 0, key: ['x'] } } });
    const entry = book.entries['0']!;

    expect(entry.content).toBe('');
    expect(entry.order).toBe(100);
    expect(entry.position).toBe(WI_POSITION.before);
    expect(entry.scanDepth).toBeNull();
    expect(entry.caseSensitive).toBeNull();
    expect(entry.matchWholeWords).toBeNull();
  });

  test('accepts a character_book shape dropped in as a standalone file', () => {
    const book = normalizeBook(richBook(), 'Rich');
    expect(book.entries['7']?.position).toBe(WI_POSITION.atDepth);
    // A standalone file has nothing to round-trip verbatim into.
    expect(book.originalData).toBeUndefined();
  });

  test('survives junk without throwing', () => {
    expect(normalizeBook(null, 'X').entries).toEqual({});
    expect(normalizeBook({ entries: 'nope' }, 'X').entries).toEqual({});
    expect(normalizeBook({ entries: { a: null, b: 5 } }, 'X').entries).toEqual({});
  });

  test('keys the Record by uid, not by the original object key', () => {
    const book = normalizeBook({ entries: { garbage: { uid: 12, content: 'hi' } } });
    expect(book.entries['12']?.content).toBe('hi');
  });

  test('preserves unknown top-level keys on an entry', () => {
    const book = normalizeBook({ entries: { '0': { uid: 0, weird_key: 'kept' } } });
    expect(book.entries['0']?.weird_key).toBe('kept');
  });
});

describe('nextUid', () => {
  test('is max + 1, so a freed uid is never reused', () => {
    const book: WorldInfoBook = {
      entries: {
        '0': createWorldInfoEntry(0),
        '1': createWorldInfoEntry(1),
        '2': createWorldInfoEntry(2),
      },
    };
    expect(nextUid(book)).toBe(3);

    // Deleting from the middle must not make the next uid collide with uid 2.
    expect(nextUid(removeEntry(book, 1))).toBe(3);
  });

  test('starts at 0 for an empty book', () => {
    expect(nextUid({ entries: {} })).toBe(0);
  });
});

describe('bookEntries', () => {
  test('sorts by displayIndex, not by the Record key order', () => {
    // Numeric-looking keys iterate in ascending numeric order, so "2" comes before "10".
    // Display order here is the reverse, which is what makes this test meaningful.
    const entries: Record<string, ReturnType<typeof createWorldInfoEntry>> = {};
    for (const uid of [2, 10, 1]) {
      entries[String(uid)] = { ...createWorldInfoEntry(uid), displayIndex: -uid };
    }

    expect(bookEntries({ entries }).map((e) => e.uid)).toEqual([10, 2, 1]);
  });

  test('breaks displayIndex ties by uid, so the order is total', () => {
    const entries: Record<string, ReturnType<typeof createWorldInfoEntry>> = {};
    for (const uid of [5, 3, 4]) {
      entries[String(uid)] = { ...createWorldInfoEntry(uid), displayIndex: 0 };
    }
    expect(bookEntries({ entries }).map((e) => e.uid)).toEqual([3, 4, 5]);
  });
});
