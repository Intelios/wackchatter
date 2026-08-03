/**
 * Conversion between the two on-disk lorebook shapes.
 *
 *   standalone file   `{ entries: { "<uid>": WorldInfoEntry } }`   — object keyed by uid
 *   embedded book     `{ name, entries: CharacterBookEntry[] }`     — array
 *
 * They are not just reshaped: the field names differ, and everything the V2 spec doesn't
 * define lives in each entry's `extensions` bag. Both directions are verified against
 * SillyTavern's own code — `convertCharacterBook` (world-info.js:5498) on read,
 * `convertWorldInfoToCharacterBook` (endpoints/characters.js:663) on write — because
 * getting a key name wrong here silently drops a field out of somebody's card.
 *
 * This lives in shared/, not server/lib/, because the browser needs it too: prompt
 * assembly runs client-side, so the activation engine and the embedded-book editor both
 * consume `WorldInfoEntry`. The server only does file I/O.
 *
 * Two ST field names are camelCase among otherwise snake_case extensions —
 * `useProbability` and `selectiveLogic`. They look like typos. They are not; ST reads and
 * writes exactly those spellings, so we must too.
 */

import type { CharacterBook, CharacterBookEntry } from '../types/card.ts';
import type {
  WiLogic,
  WiPosition,
  WiRole,
  WorldInfoBook,
  WorldInfoEntry,
} from '../types/worldinfo.ts';
import {
  createWorldInfoEntry,
  WI_DEFAULT_DEPTH,
  WI_DEFAULT_WEIGHT,
  WI_LOGIC,
  WI_POSITION,
  WI_ROLE,
} from '../types/worldinfo.ts';

/* --- reading ------------------------------------------------------------- */

function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** `T | null` where null carries meaning ("inherit the global setting"). */
function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asEnum<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

const POSITIONS = Object.values(WI_POSITION) as WiPosition[];
const LOGICS = Object.values(WI_LOGIC) as WiLogic[];
const ROLES = Object.values(WI_ROLE) as WiRole[];

/**
 * One embedded entry into our internal shape.
 *
 * `position` is the interesting one: ST writes the real numeric position into
 * `extensions.position` and degrades the top-level field to `before_char`/`after_char`,
 * so the extension wins and the top-level field is only the fallback for a book written
 * by something that isn't ST.
 */
function entryFromCharacterBook(
  raw: CharacterBookEntry,
  uid: number,
  index: number,
): WorldInfoEntry {
  const ext = (raw.extensions ?? {}) as Record<string, unknown>;
  const base = createWorldInfoEntry(uid);

  return {
    ...base,
    uid,
    key: asArray(raw.keys),
    keysecondary: asArray(raw.secondary_keys),
    comment: asString(raw.comment, ''),
    content: asString(raw.content, ''),
    constant: asBoolean(raw.constant, false),
    selective: asBoolean(raw.selective, false),
    order: asNumber(raw.insertion_order, base.order),
    disable: !asBoolean(raw.enabled, true),
    addMemo: Boolean(raw.comment),

    position: asEnum(
      ext.position,
      POSITIONS,
      raw.position === 'before_char' ? WI_POSITION.before : WI_POSITION.after,
    ),
    displayIndex: asNumber(ext.display_index, index),
    excludeRecursion: asBoolean(ext.exclude_recursion, false),
    preventRecursion: asBoolean(ext.prevent_recursion, false),
    delayUntilRecursion:
      typeof ext.delay_until_recursion === 'number' ||
      typeof ext.delay_until_recursion === 'boolean'
        ? ext.delay_until_recursion
        : false,
    probability: asNumber(ext.probability, 100),
    useProbability: asBoolean(ext.useProbability, true),
    depth: asNumber(ext.depth, WI_DEFAULT_DEPTH),
    selectiveLogic: asEnum(ext.selectiveLogic, LOGICS, WI_LOGIC.AND_ANY),
    outletName: asString(ext.outlet_name, ''),
    group: asString(ext.group, ''),
    groupOverride: asBoolean(ext.group_override, false),
    groupWeight: asNumber(ext.group_weight, WI_DEFAULT_WEIGHT),
    scanDepth: asNullableNumber(ext.scan_depth),
    caseSensitive: asNullableBoolean(ext.case_sensitive),
    matchWholeWords: asNullableBoolean(ext.match_whole_words),
    useGroupScoring: asNullableBoolean(ext.use_group_scoring),
    automationId: asString(ext.automation_id, ''),
    role: asEnum(ext.role, ROLES, WI_ROLE.SYSTEM),
    vectorized: asBoolean(ext.vectorized, false),
    sticky: asNullableNumber(ext.sticky),
    cooldown: asNullableNumber(ext.cooldown),
    delay: asNullableNumber(ext.delay),
    ignoreBudget: asBoolean(ext.ignore_budget, false),
    triggers: asArray(ext.triggers),

    // Verbatim. This is what carries third-party keys and the ST fields we don't model
    // (character_filter, the six extra match_* scan sources) across a round-trip.
    extensions: { ...ext },
  };
}

/**
 * An embedded `character_book` into a standalone-shaped book.
 *
 * `uid` prefers the entry's own `id` so a round-trip is stable, but a book with duplicate
 * ids would silently lose entries into the same Record slot, so a taken id is reassigned.
 */
export function toWorldInfoBook(book: CharacterBook): WorldInfoBook {
  const entries: Record<string, WorldInfoEntry> = {};
  const rawEntries = Array.isArray(book.entries) ? book.entries : [];

  let nextFree = 0;
  const taken = new Set<number>();
  for (const raw of rawEntries) {
    if (typeof raw?.id === 'number' && Number.isInteger(raw.id) && raw.id >= 0) taken.add(raw.id);
  }
  const allocate = (): number => {
    while (taken.has(nextFree)) nextFree++;
    taken.add(nextFree);
    return nextFree;
  };

  const claimed = new Set<number>();
  rawEntries.forEach((raw, index) => {
    const id = raw?.id;
    let uid: number;
    if (typeof id === 'number' && Number.isInteger(id) && id >= 0 && !claimed.has(id)) {
      uid = id;
      claimed.add(id);
    } else {
      uid = allocate();
      claimed.add(uid);
    }
    entries[String(uid)] = entryFromCharacterBook(raw, uid, index);
  });

  return {
    name: book.name,
    description: book.description,
    scan_depth: book.scan_depth,
    token_budget: book.token_budget,
    recursive_scanning: book.recursive_scanning,
    extensions: { ...(book.extensions ?? {}) },
    entries,
    // The book exactly as parsed, so per-entry unknown TOP-LEVEL keys (priority, name,
    // vendor keys) survive an edit — the extensions bag only covers what sits inside it.
    originalData: structuredClone(book),
  };
}

/* --- writing ------------------------------------------------------------- */

/** The original array entry a uid came from, for rebuilding on write. */
function originalEntryFor(book: WorldInfoBook, uid: number): CharacterBookEntry | undefined {
  const original = book.originalData as CharacterBook | undefined;
  if (!original || !Array.isArray(original.entries)) return undefined;
  return original.entries.find((entry) => entry?.id === uid);
}

/**
 * Our shape back to an embedded `character_book`.
 *
 * Each entry is rebuilt from its original before the mapped fields overwrite it, and the
 * extensions bag is spread before the named extension keys. Those two spreads are the
 * whole mechanism by which a third-party key survives being edited here — the same
 * mechanism `mergeCardData` uses at the card level.
 *
 * `use_regex: true` is unconditional, matching ST ("ST keys are always regex"). We don't
 * read it back: a key is a regex iff it parses as a `/…/flags` literal.
 */
export function toCharacterBook(book: WorldInfoBook, name: string): CharacterBook {
  const entries: CharacterBookEntry[] = bookEntries(book).map((entry) => {
    const original = originalEntryFor(book, entry.uid);

    return {
      ...original,
      id: entry.uid,
      keys: entry.key,
      secondary_keys: entry.keysecondary,
      comment: entry.comment,
      content: entry.content,
      constant: entry.constant,
      selective: entry.selective,
      insertion_order: entry.order,
      enabled: !entry.disable,
      // Lossy by design, exactly as ST writes it: the real value is in extensions.
      position: entry.position === WI_POSITION.before ? 'before_char' : 'after_char',
      use_regex: true,
      extensions: {
        ...(entry.extensions ?? {}),
        position: entry.position,
        exclude_recursion: entry.excludeRecursion,
        prevent_recursion: entry.preventRecursion,
        delay_until_recursion: entry.delayUntilRecursion,
        display_index: entry.displayIndex,
        probability: entry.probability,
        useProbability: entry.useProbability,
        depth: entry.depth,
        selectiveLogic: entry.selectiveLogic,
        outlet_name: entry.outletName,
        group: entry.group,
        group_override: entry.groupOverride,
        group_weight: entry.groupWeight,
        scan_depth: entry.scanDepth,
        case_sensitive: entry.caseSensitive,
        match_whole_words: entry.matchWholeWords,
        use_group_scoring: entry.useGroupScoring,
        automation_id: entry.automationId,
        role: entry.role,
        vectorized: entry.vectorized,
        sticky: entry.sticky,
        cooldown: entry.cooldown,
        delay: entry.delay,
        triggers: entry.triggers ?? [],
        ignore_budget: entry.ignoreBudget,
      },
    };
  });

  const original = book.originalData as CharacterBook | undefined;

  return {
    ...original,
    name,
    ...(book.description !== undefined ? { description: book.description } : {}),
    ...(book.scan_depth !== undefined ? { scan_depth: book.scan_depth } : {}),
    ...(book.token_budget !== undefined ? { token_budget: book.token_budget } : {}),
    ...(book.recursive_scanning !== undefined
      ? { recursive_scanning: book.recursive_scanning }
      : {}),
    // ST omits this; its own validator requires it. Always emit at least `{}`.
    extensions: { ...(book.extensions ?? {}) },
    entries,
  };
}

/* --- standalone books ---------------------------------------------------- */

/**
 * A parsed JSON file into a book we can rely on. Permissive on purpose: a book from
 * anywhere should load with defaults filled rather than be rejected.
 *
 * Accepts both shapes, because a user will export a character_book from somewhere and
 * drop it in as a standalone file.
 */
export function normalizeBook(raw: unknown, fallbackName?: string): WorldInfoBook {
  if (!raw || typeof raw !== 'object') {
    return { name: fallbackName, entries: {}, extensions: {} };
  }

  const source = raw as Record<string, unknown>;
  const name = asString(source.name, fallbackName ?? '') || fallbackName;

  // The array shape is a character_book — convert rather than reject.
  if (Array.isArray(source.entries)) {
    const converted = toWorldInfoBook(source as unknown as CharacterBook);
    // A standalone file is not an embedded book, so there is nothing to round-trip
    // verbatim into. Keeping originalData here would be ST's behaviour, but it would also
    // mean a standalone book carried a shadow copy of itself forever.
    return { ...converted, name: name ?? converted.name, originalData: undefined };
  }

  const rawEntries =
    source.entries && typeof source.entries === 'object'
      ? (source.entries as Record<string, unknown>)
      : {};

  const entries: Record<string, WorldInfoEntry> = {};
  let index = 0;
  for (const [key, value] of Object.entries(rawEntries)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Record<string, unknown>;
    const uid = asNumber(candidate.uid, Number.parseInt(key, 10));
    if (!Number.isInteger(uid) || uid < 0) continue;

    const base = createWorldInfoEntry(uid);
    entries[String(uid)] = {
      // Unknown top-level keys on a standalone entry survive by being spread through.
      ...base,
      ...candidate,
      uid,
      key: asArray(candidate.key),
      keysecondary: asArray(candidate.keysecondary),
      comment: asString(candidate.comment, ''),
      content: asString(candidate.content, ''),
      constant: asBoolean(candidate.constant, false),
      selective: asBoolean(candidate.selective, base.selective),
      selectiveLogic: asEnum(candidate.selectiveLogic, LOGICS, WI_LOGIC.AND_ANY),
      order: asNumber(candidate.order, base.order),
      displayIndex: asNumber(candidate.displayIndex, index),
      position: asEnum(candidate.position, POSITIONS, WI_POSITION.before),
      disable: asBoolean(candidate.disable, false),
      ignoreBudget: asBoolean(candidate.ignoreBudget, false),
      excludeRecursion: asBoolean(candidate.excludeRecursion, false),
      preventRecursion: asBoolean(candidate.preventRecursion, false),
      probability: asNumber(candidate.probability, 100),
      useProbability: asBoolean(candidate.useProbability, true),
      depth: asNumber(candidate.depth, WI_DEFAULT_DEPTH),
      outletName: asString(candidate.outletName, ''),
      group: asString(candidate.group, ''),
      groupOverride: asBoolean(candidate.groupOverride, false),
      groupWeight: asNumber(candidate.groupWeight, WI_DEFAULT_WEIGHT),
      scanDepth: asNullableNumber(candidate.scanDepth),
      caseSensitive: asNullableBoolean(candidate.caseSensitive),
      matchWholeWords: asNullableBoolean(candidate.matchWholeWords),
      useGroupScoring: asNullableBoolean(candidate.useGroupScoring),
      automationId: asString(candidate.automationId, ''),
      role: asEnum(candidate.role, ROLES, WI_ROLE.SYSTEM),
      vectorized: asBoolean(candidate.vectorized, false),
      sticky: asNullableNumber(candidate.sticky),
      cooldown: asNullableNumber(candidate.cooldown),
      delay: asNullableNumber(candidate.delay),
      triggers: asArray(candidate.triggers),
      extensions:
        candidate.extensions && typeof candidate.extensions === 'object'
          ? { ...(candidate.extensions as Record<string, unknown>) }
          : {},
    };
    index++;
  }

  return { ...source, name, entries, extensions: { ...((source.extensions as object) ?? {}) } };
}

/* --- helpers ------------------------------------------------------------- */

/**
 * The next free uid.
 *
 * `max + 1`, never `length` — after deleting from the middle of a book, `length` would
 * hand back a uid that is already in use.
 *
 * And the max is taken over `originalData` as well as the live entries, because
 * `toCharacterBook` rebuilds each entry from the original with the SAME uid. Deleting the
 * highest entry and adding a new one would otherwise reuse that uid, and the new entry
 * would silently inherit the deleted one's unknown top-level keys — a `priority`, a
 * vendor field, or a `name` belonging to lore the user removed on purpose.
 */
export function nextUid(book: WorldInfoBook): number {
  let max = -1;
  for (const entry of Object.values(book.entries)) {
    if (entry.uid > max) max = entry.uid;
  }

  const original = book.originalData as CharacterBook | undefined;
  if (original && Array.isArray(original.entries)) {
    for (const entry of original.entries) {
      if (typeof entry?.id === 'number' && entry.id > max) max = entry.id;
    }
  }

  return max + 1;
}

/**
 * A book without one entry.
 *
 * Returns a new book rather than deleting in place — `originalData` deliberately keeps
 * the removed entry, because a later write must not resurrect it and a later `nextUid`
 * must not reuse its uid.
 */
export function removeEntry(book: WorldInfoBook, uid: number): WorldInfoBook {
  const entries: Record<string, WorldInfoEntry> = {};
  for (const [key, entry] of Object.entries(book.entries)) {
    if (entry.uid !== uid) entries[key] = entry;
  }
  return { ...book, entries };
}

/**
 * Entries as a list, in display order.
 *
 * Never iterate `book.entries` directly for anything order-sensitive: the keys are
 * numeric strings, and an object with numeric-looking keys iterates in ascending NUMERIC
 * order, so `"2"` comes before `"10"` — which looks like display order right up until a
 * book has more than ten entries.
 */
export function bookEntries(book: WorldInfoBook): WorldInfoEntry[] {
  return Object.values(book.entries).sort(
    (a, b) => a.displayIndex - b.displayIndex || a.uid - b.uid,
  );
}
