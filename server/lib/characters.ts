/**
 * Character storage: cards live as PNG files under data/characters, one file per character.
 *
 * The filename (including extension) is the character's identity, exactly as in
 * SillyTavern — the `avatar` field inside the card JSON is vestigial and always "none".
 *
 * Cards may sit in subdirectories, which are the user-facing folders. The folder is NOT part
 * of the identity, so every path here is resolved by searching the tree for the filename
 * rather than by joining it onto the root. See folders.ts for why that matters.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
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
import {
  CHARACTER_IDENTITIES,
  folderOf,
  resolveCharacterFile,
  walkCharacterFiles,
} from './folders.ts';
import { atomicWrite, withFileLock, withFileLocks, withResourceLock } from './fs.ts';
import {
  PATHS,
  PROJECT_ROOT,
  safeJoinFolder,
  sanitizeFilename,
  sanitizeFolderPath,
  uniqueName,
} from './paths.ts';

/**
 * Placeholder used when a character is created without an uploaded image.
 *
 * Anchored to PROJECT_ROOT, not the data directory: this is a shipped asset, so it must not
 * travel when the user moves their library. It is also the one place that captured a PATHS
 * field at module scope, which a movable root makes actively wrong.
 */
const BLANK_AVATAR_PATH = join(PROJECT_ROOT, 'assets', 'blank-avatar.png');

function summarize(
  avatar: string,
  card: TavernCard,
  modified: number,
  folder = '',
): CharacterSummary {
  return {
    avatar,
    folder,
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
  const summaries: CharacterSummary[] = [];
  const seen = new Set<string>();

  for (const file of walkCharacterFiles()) {
    // The walk is ordered shallowest-first, so a duplicate basename made outside the app
    // resolves to the same file here as it does in resolveCharacterFile. Listing both would
    // put two rows in the UI that load and save the same card.
    if (seen.has(file.avatar)) {
      console.warn(`[characters] duplicate name "${file.avatar}" in "${file.folder}" is hidden`);
      continue;
    }
    seen.add(file.avatar);

    try {
      const card = readCard(new Uint8Array(readFileSync(file.path)));
      summaries.push(summarize(file.avatar, card, statSync(file.path).mtimeMs, file.folder));
    } catch (error) {
      console.warn(`[characters] skipping "${file.avatar}": ${(error as Error).message}`);
    }
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCharacter(avatar: string): CharacterDetail | null {
  const path = resolveCharacterFile(avatar);
  if (!path) return null;

  const card = readCard(new Uint8Array(readFileSync(path)));
  return { ...summarize(avatar, card, statSync(path).mtimeMs, folderOf(path)), card };
}

/** Raw PNG bytes, for serving the avatar image. */
export function getCharacterImage(avatar: string): Uint8Array | null {
  const path = resolveCharacterFile(avatar);
  if (!path) return null;
  return new Uint8Array(readFileSync(path));
}

/**
 * Every filename currently in use, anywhere in the tree, lowercased.
 *
 * Built once and closed over rather than probed per candidate: uniqueName can ask up to ten
 * thousand times, and a tree walk each time would be absurd. Lowercased because macOS and
 * Windows are case-insensitive, so "alice.png" and "Alice.png" are one file there — folding
 * case makes an identity collision impossible on every platform rather than most of them.
 */
function takenAvatars(): Set<string> {
  return new Set(walkCharacterFiles().map((file) => file.avatar.toLowerCase()));
}

type Rollback = () => Promise<void> | void;

/**
 * Write a card into a new PNG file, choosing a free filename derived from the name.
 * @param image PNG bytes to embed into; a blank placeholder is used if omitted.
 * @param folder Where to put it; '' is the top level. Created if it does not exist.
 */
export async function createCharacter(
  card: TavernCard,
  image?: Uint8Array,
  folder = '',
): Promise<CharacterDetail> {
  return withResourceLock(CHARACTER_IDENTITIES, async () => {
    const targetFolder = sanitizeFolderPath(folder) ?? '';
    const directory = safeJoinFolder(PATHS.characters, targetFolder) ?? PATHS.characters;

    const safeName = sanitizeFilename(card.data.name) ?? 'Character';
    // Uniqueness spans the whole tree, not just the destination folder: the filename alone
    // is the identity, so two cards called Alice in different folders would be one character.
    const taken = takenAvatars();
    const filename = `${uniqueName(safeName, (candidate) => taken.has(`${candidate.toLowerCase()}.png`))}.png`;

    mkdirSync(directory, { recursive: true });
    const base = image ?? loadBlankAvatar();
    await atomicWrite(join(directory, filename), writeCard(base, card));

    return { ...summarize(filename, card, Date.now(), targetFolder), card };
  });
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
  const path = resolveCharacterFile(avatar);
  if (!path) return null;

  return withFileLock(path, async (replace) => {
    if (!existsSync(path)) return null;
    const existing = new Uint8Array(readFileSync(path));
    const merged = mergeCardData(readCard(existing), updates);

    await replace(writeCard(image ?? existing, merged));
    return { ...summarize(avatar, merged, Date.now(), folderOf(path)), card: merged };
  });
}

/** Rename the underlying file, keeping the card's `name` field in sync. */
export async function renameCharacter(
  avatar: string,
  newName: string,
  onStaged?: (newAvatar: string) => Promise<Rollback | undefined>,
): Promise<CharacterDetail | null> {
  return withResourceLock(CHARACTER_IDENTITIES, async () => {
    const path = resolveCharacterFile(avatar);
    if (!path) return null;

    const safeName = sanitizeFilename(newName);
    if (!safeName) return null;

    const taken = takenAvatars();
    const filename = `${uniqueName(safeName, (candidate) => taken.has(`${candidate.toLowerCase()}.png`))}.png`;
    // A rename is not a move: the card stays in whichever folder it is already in.
    const newPath = join(dirname(path), filename);

    return withFileLocks([path, newPath], async (replace) => {
      if (!existsSync(path)) return null;
      const existing = new Uint8Array(readFileSync(path));
      const card = mergeCardData(readCard(existing), { name: newName });
      await replace(newPath, writeCard(existing, card));

      let rollback: Rollback | undefined;
      try {
        rollback = await onStaged?.(filename);
        if (newPath !== path) await unlink(path);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (rollback) {
          try {
            await rollback();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        try {
          if (newPath === path) await replace(path, existing);
          else await unlink(newPath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], 'Character rename rollback failed.');
        }
        throw error;
      }

      return { ...summarize(filename, card, Date.now(), folderOf(newPath)), card };
    });
  });
}

export async function deleteCharacter(
  avatar: string,
  onStaged?: () => Promise<void>,
): Promise<boolean> {
  const path = resolveCharacterFile(avatar);
  if (!path) return false;

  return withResourceLock(CHARACTER_IDENTITIES, () =>
    withFileLock(path, async () => {
      if (!existsSync(path)) return false;
      const tombstone = `${path}.${crypto.randomUUID()}.deleting`;
      await rename(path, tombstone);
      try {
        await onStaged?.();
      } catch (error) {
        await rename(tombstone, path).catch((rollbackError) => {
          throw new AggregateError([error, rollbackError], 'Character delete rollback failed.');
        });
        throw error;
      }

      // Once the reference cascade has committed, the tombstone is logically deleted.
      // A cleanup failure must not resurrect it or report that the deletion did not happen.
      await unlink(tombstone).catch((error) => {
        console.error(`[wackchatter] Could not remove character tombstone: ${String(error)}`);
      });
      return true;
    }),
  );
}

/**
 * Repoint every card that links to a standalone lorebook by name (`data.extensions.world`).
 *
 * A lorebook's filename is its identity and a card links to it by that name, so a rename
 * or delete that left these links alone would silently strand every card pointing at the
 * old name. `newName === null` clears the link (a deletion); otherwise it is rewritten.
 *
 * `dir` defaults to the character directory but is injectable so the cascade is testable
 * against a scratch directory without touching real data. Returns the number of cards changed.
 */
export async function updateWorldLinks(
  oldName: string,
  newName: string | null,
  dir: string = PATHS.characters,
): Promise<number> {
  const changed = await rewriteWorldLinks(oldName, newName, dir);
  return changed.length;
}

/**
 * Apply a reference rewrite and return an exact rollback for the files this call changed.
 * The rollback is used when a later step in a cross-store lorebook migration fails.
 */
export async function updateWorldLinksRecoverable(
  oldName: string,
  newName: string | null,
  dir: string = PATHS.characters,
): Promise<Rollback> {
  const changed = await rewriteWorldLinks(oldName, newName, dir);
  return async () => {
    await rewriteWorldLinksInFiles(changed, newName, oldName, dir);
  };
}

async function rewriteWorldLinks(
  oldName: string | null,
  newName: string | null,
  dir: string,
): Promise<string[]> {
  if (!existsSync(dir)) return [];

  // Recursive: cards live in user-made subfolders, and a flat listing here would silently
  // strand every foldered card that links to the lorebook being renamed.
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((file) =>
    file.toLowerCase().endsWith('.png'),
  );
  const changed: string[] = [];
  try {
    for (const file of files) {
      if (await rewriteWorldLinkFile(file, oldName, newName, dir)) changed.push(file);
    }
  } catch (error) {
    try {
      await rewriteWorldLinksInFiles(changed, newName, oldName, dir);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Character world-link rollback failed.');
    }
    throw error;
  }

  return changed;
}

async function rewriteWorldLinksInFiles(
  files: string[],
  expected: string | null,
  next: string | null,
  dir: string,
): Promise<void> {
  for (const file of [...files].reverse()) {
    await rewriteWorldLinkFile(file, expected, next, dir);
  }
}

async function rewriteWorldLinkFile(
  file: string,
  expected: string | null,
  next: string | null,
  dir: string,
): Promise<boolean> {
  const full = join(dir, file);
  return withFileLock(full, async (replace) => {
    if (!existsSync(full)) return false;

    let existing: Uint8Array;
    let card: TavernCard;
    try {
      existing = new Uint8Array(readFileSync(full));
      card = readCard(existing);
    } catch {
      // An unreadable card is skipped here exactly as it is in listCharacters — a lorebook
      // rename is not the moment to fail loudly over one bad file.
      return false;
    }

    if ((card.data.extensions?.world ?? null) !== expected) return false;
    const merged = mergeCardData(card, { extensions: { world: next ?? undefined } });
    await replace(writeCard(existing, merged));
    return true;
  });
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
  const path = resolveCharacterFile(avatar);
  if (!path) return null;

  return withFileLock(path, async (replace) => {
    if (!existsSync(path)) return null;
    const existing = new Uint8Array(readFileSync(path));
    const card = readCard(existing);
    const stored = card.data.character_book ?? { extensions: {}, entries: [] };

    const next = mutate(toWorldInfoBook(stored));
    if (!next) return null;

    const merged = mergeCardData(card, {
      character_book: toCharacterBook(next, next.name || card.data.name || 'Lorebook'),
    });

    await replace(writeCard(existing, merged));
    return { ...summarize(avatar, merged, Date.now(), folderOf(path)), card: merged };
  });
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
  const path = resolveCharacterFile(avatar);
  if (!path) return null;

  return withFileLock(path, async (replace) => {
    if (!existsSync(path)) return null;
    const existing = new Uint8Array(readFileSync(path));
    const card = readCard(existing);
    if (!card.data.character_book) return null;

    const merged = mergeCardData(card, { character_book: undefined });
    await replace(writeCard(existing, merged));
    return { ...summarize(avatar, merged, Date.now(), folderOf(path)), card: merged };
  });
}

/**
 * Import a card from PNG or JSON bytes.
 * JSON imports get the blank placeholder image; PNG imports keep their artwork.
 */
export async function importCharacter(
  bytes: Uint8Array,
  filename: string,
  folder = '',
): Promise<CharacterDetail> {
  const isPng = filename.toLowerCase().endsWith('.png');

  if (isPng) {
    const card = readCard(bytes);
    return createCharacter(card, bytes, folder);
  }

  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Import failed: file is neither a PNG card nor valid JSON.');
  }
  return createCharacter(normalizeCard(parsed), undefined, folder);
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
