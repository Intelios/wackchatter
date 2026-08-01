/**
 * Character storage: cards live as PNG files in data/characters, one file per character.
 *
 * The filename (including extension) is the character's identity, exactly as in
 * SillyTavern — the `avatar` field inside the card JSON is vestigial and always "none".
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type {
  CardDataV2,
  CharacterDetail,
  CharacterSummary,
  TavernCard,
} from '../../shared/types/card.ts';
import type { WorldInfoBook, WorldInfoEntry } from '../../shared/types/worldinfo.ts';
import { createWorldInfoEntry } from '../../shared/types/worldinfo.ts';
import {
  bookEntries,
  nextUid,
  removeEntry,
  toCharacterBook,
  toWorldInfoBook,
} from '../../shared/worldinfo/convert.ts';
import { createBlankCard, mergeCardData, normalizeCard, readCard, writeCard } from './card.ts';
import { atomicWrite } from './fs.ts';
import { PATHS, safeJoin, sanitizeFilename, uniqueName } from './paths.ts';

/** Placeholder used when a character is created without an uploaded image. */
const BLANK_AVATAR_PATH = join(PATHS.root, '..', 'assets', 'blank-avatar.png');

function summarize(avatar: string, card: TavernCard, modified: number): CharacterSummary {
  return {
    avatar,
    name: card.data.name || basename(avatar, extname(avatar)),
    description: card.data.description,
    creator: card.data.creator,
    tags: card.data.tags,
    character_version: card.data.character_version,
    hasLorebook: Boolean(card.data.character_book?.entries?.length),
    alternateGreetingCount: card.data.alternate_greetings.length,
    modified,
  };
}

/**
 * List every character. Unreadable files are skipped with a warning rather than
 * failing the whole listing — one bad card should not hide the rest of a library.
 */
export function listCharacters(): CharacterSummary[] {
  if (!existsSync(PATHS.characters)) return [];

  const summaries: CharacterSummary[] = [];
  for (const file of readdirSync(PATHS.characters)) {
    if (!file.toLowerCase().endsWith('.png')) continue;
    const full = join(PATHS.characters, file);
    try {
      const card = readCard(new Uint8Array(readFileSync(full)));
      summaries.push(summarize(file, card, statSync(full).mtimeMs));
    } catch (error) {
      console.warn(`[characters] skipping "${file}": ${(error as Error).message}`);
    }
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCharacter(avatar: string): CharacterDetail | null {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return null;

  const card = readCard(new Uint8Array(readFileSync(path)));
  return { ...summarize(avatar, card, statSync(path).mtimeMs), card };
}

/** Raw PNG bytes, for serving the avatar image. */
export function getCharacterImage(avatar: string): Uint8Array | null {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

function characterExists(name: string): boolean {
  return existsSync(join(PATHS.characters, `${name}.png`));
}

/**
 * Write a card into a new PNG file, choosing a free filename derived from the name.
 * @param image PNG bytes to embed into; a blank placeholder is used if omitted.
 */
export async function createCharacter(
  card: TavernCard,
  image?: Uint8Array,
): Promise<CharacterDetail> {
  const safeName = sanitizeFilename(card.data.name) ?? 'Character';
  const filename = `${uniqueName(safeName, characterExists)}.png`;
  const path = join(PATHS.characters, filename);

  const base = image ?? loadBlankAvatar();
  await atomicWrite(path, writeCard(base, card));

  return { ...summarize(filename, card, Date.now()), card };
}

/**
 * Apply a partial update to an existing character.
 *
 * Reads the card back off disk first so unknown keys are merged onto the real stored
 * card, never onto whatever subset the client happened to send.
 */
export async function updateCharacter(
  avatar: string,
  updates: Partial<CardDataV2>,
  image?: Uint8Array,
): Promise<CharacterDetail | null> {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return null;

  const existing = new Uint8Array(readFileSync(path));
  const merged = mergeCardData(readCard(existing), updates);

  await atomicWrite(path, writeCard(image ?? existing, merged));
  return { ...summarize(avatar, merged, Date.now()), card: merged };
}

/** Rename the underlying file, keeping the card's `name` field in sync. */
export async function renameCharacter(
  avatar: string,
  newName: string,
): Promise<CharacterDetail | null> {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return null;

  const safeName = sanitizeFilename(newName);
  if (!safeName) return null;

  const existing = new Uint8Array(readFileSync(path));
  const card = mergeCardData(readCard(existing), { name: newName });
  const filename = `${uniqueName(safeName, characterExists)}.png`;
  const newPath = join(PATHS.characters, filename);

  await atomicWrite(newPath, writeCard(existing, card));
  if (newPath !== path) unlinkSync(path);

  return { ...summarize(filename, card, Date.now()), card };
}

export function deleteCharacter(avatar: string): boolean {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ---------------------------------------------------------------------------
// The embedded lorebook
// ---------------------------------------------------------------------------

/**
 * Mutate the card's `character_book` one entry at a time.
 *
 * Deliberately NOT a whole-book PUT. `mergeCardData` replaces `character_book` wholesale
 * (see its comment), so never handing it a client-built book is what makes that safe:
 * every mutation here starts from the book as stored on disk. A stale browser tab cannot
 * write a mass deletion into somebody's PNG, and a 200-entry book isn't re-uploaded on
 * every keystroke's debounce.
 *
 * The conversion round-trip on each call is what preserves unknown keys — `originalData`
 * carries per-entry top-level keys, and the entry's `extensions` bag carries the rest.
 *
 * Because `originalData` is rebuilt from the stored PNG on every call, a uid freed by a
 * delete IS safely reusable here: the deleted entry is no longer on disk, so there is
 * nothing left for a new entry to inherit. `nextUid` still refuses to reuse it, which
 * matters for the client-side editor, where a book is held in memory across both edits.
 */
async function mutateBook(
  avatar: string,
  mutate: (book: WorldInfoBook) => WorldInfoBook | null,
): Promise<CharacterDetail | null> {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return null;

  const existing = new Uint8Array(readFileSync(path));
  const card = readCard(existing);
  const stored = card.data.character_book ?? { extensions: {}, entries: [] };

  const next = mutate(toWorldInfoBook(stored));
  if (!next) return null;

  const merged = mergeCardData(card, {
    character_book: toCharacterBook(next, next.name || card.data.name || 'Lorebook'),
  });

  await atomicWrite(path, writeCard(existing, merged));
  return { ...summarize(avatar, merged, Date.now()), card: merged };
}

export async function addBookEntry(
  avatar: string,
): Promise<{ detail: CharacterDetail; uid: number } | null> {
  let created = -1;

  const detail = await mutateBook(avatar, (book) => {
    const uid = nextUid(book);
    created = uid;
    const entry = createWorldInfoEntry(uid);
    // Appended to the end of the list, which is where a new entry is expected to appear.
    entry.displayIndex = bookEntries(book).length;
    // Blank content would be dropped by the engine as `empty`, so a brand-new entry has
    // to say something or it looks broken the moment it is created.
    entry.content = 'New entry.';
    return { ...book, entries: { ...book.entries, [String(uid)]: entry } };
  });

  return detail ? { detail, uid: created } : null;
}

export async function updateBookEntry(
  avatar: string,
  uid: number,
  patch: Partial<WorldInfoEntry>,
): Promise<CharacterDetail | null> {
  return mutateBook(avatar, (book) => {
    const current = book.entries[String(uid)];
    if (!current) return null;

    // `uid` is forced back: it keys the Record and links the entry to its originalData,
    // so letting a client change it would silently orphan every unknown key it carries.
    const next: WorldInfoEntry = { ...current, ...patch, uid };
    return { ...book, entries: { ...book.entries, [String(uid)]: next } };
  });
}

export async function deleteBookEntry(
  avatar: string,
  uid: number,
): Promise<CharacterDetail | null> {
  return mutateBook(avatar, (book) => {
    if (!book.entries[String(uid)]) return null;
    return removeEntry(book, uid);
  });
}

/** Book-level fields: the four the V2 spec defines, plus the display order. */
export async function updateBook(
  avatar: string,
  fields: {
    name?: string;
    description?: string;
    scan_depth?: number;
    token_budget?: number;
    recursive_scanning?: boolean;
    displayOrder?: number[];
  },
): Promise<CharacterDetail | null> {
  return mutateBook(avatar, (book) => {
    const next: WorldInfoBook = { ...book };
    if (fields.name !== undefined) next.name = fields.name;
    if (fields.description !== undefined) next.description = fields.description;
    if (fields.scan_depth !== undefined) next.scan_depth = fields.scan_depth;
    if (fields.token_budget !== undefined) next.token_budget = fields.token_budget;
    if (fields.recursive_scanning !== undefined) {
      next.recursive_scanning = fields.recursive_scanning;
    }

    // A drag rewrites displayIndex and nothing else. `order` is a weight where ties are
    // legal; a permutation cannot be expressed in it without inventing values.
    if (fields.displayOrder) {
      const entries = { ...next.entries };
      fields.displayOrder.forEach((uid, index) => {
        const entry = entries[String(uid)];
        if (entry) entries[String(uid)] = { ...entry, displayIndex: index };
      });
      next.entries = entries;
    }

    return next;
  });
}

/** Remove the embedded book entirely. */
export async function deleteBook(avatar: string): Promise<CharacterDetail | null> {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return null;

  const existing = new Uint8Array(readFileSync(path));
  const card = readCard(existing);
  if (!card.data.character_book) return null;

  const merged = mergeCardData(card, { character_book: undefined });
  await atomicWrite(path, writeCard(existing, merged));
  return { ...summarize(avatar, merged, Date.now()), card: merged };
}

/**
 * Import a card from PNG or JSON bytes.
 * JSON imports get the blank placeholder image; PNG imports keep their artwork.
 */
export async function importCharacter(
  bytes: Uint8Array,
  filename: string,
): Promise<CharacterDetail> {
  const isPng = filename.toLowerCase().endsWith('.png');

  if (isPng) {
    const card = readCard(bytes);
    return createCharacter(card, bytes);
  }

  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Import failed: file is neither a PNG card nor valid JSON.');
  }
  return createCharacter(normalizeCard(parsed));
}

let blankAvatarCache: Uint8Array | null = null;

/**
 * A 1x1 transparent PNG, used as the carrier image when a card arrives without artwork.
 * Inlined so the app has no binary asset dependency for a core path.
 */
function loadBlankAvatar(): Uint8Array {
  if (blankAvatarCache) return blankAvatarCache;

  if (existsSync(BLANK_AVATAR_PATH)) {
    blankAvatarCache = new Uint8Array(readFileSync(BLANK_AVATAR_PATH));
    return blankAvatarCache;
  }

  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  blankAvatarCache = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return blankAvatarCache;
}

export { createBlankCard };
