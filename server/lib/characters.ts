/**
 * Character storage: cards live as PNG files in data/characters, one file per character.
 *
 * The filename (including extension) is the character's identity, exactly as in
 * SillyTavern — the `avatar` field inside the card JSON is vestigial and always "none".
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type {
  CardDataV2,
  CharacterDetail,
  CharacterSummary,
  TavernCard,
} from '../../shared/types/card.ts';
import { createBlankCard, mergeCardData, normalizeCard, readCard, writeCard } from './card.ts';
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
export function createCharacter(card: TavernCard, image?: Uint8Array): CharacterDetail {
  const safeName = sanitizeFilename(card.data.name) ?? 'Character';
  const filename = `${uniqueName(safeName, characterExists)}.png`;
  const path = join(PATHS.characters, filename);

  const base = image ?? loadBlankAvatar();
  Bun.write(path, writeCard(base, card));

  return { ...summarize(filename, card, Date.now()), card };
}

/**
 * Apply a partial update to an existing character.
 *
 * Reads the card back off disk first so unknown keys are merged onto the real stored
 * card, never onto whatever subset the client happened to send.
 */
export function updateCharacter(
  avatar: string,
  updates: Partial<CardDataV2>,
  image?: Uint8Array,
): CharacterDetail | null {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return null;

  const existing = new Uint8Array(readFileSync(path));
  const merged = mergeCardData(readCard(existing), updates);

  Bun.write(path, writeCard(image ?? existing, merged));
  return { ...summarize(avatar, merged, Date.now()), card: merged };
}

/** Rename the underlying file, keeping the card's `name` field in sync. */
export function renameCharacter(avatar: string, newName: string): CharacterDetail | null {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return null;

  const safeName = sanitizeFilename(newName);
  if (!safeName) return null;

  const card = mergeCardData(readCard(new Uint8Array(readFileSync(path))), { name: newName });
  const filename = `${uniqueName(safeName, characterExists)}.png`;
  const newPath = join(PATHS.characters, filename);

  Bun.write(path, writeCard(new Uint8Array(readFileSync(path)), card));
  if (newPath !== path) renameSync(path, newPath);

  return { ...summarize(filename, card, Date.now()), card };
}

export function deleteCharacter(avatar: string): boolean {
  const path = safeJoin(PATHS.characters, avatar);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * Import a card from PNG or JSON bytes.
 * JSON imports get the blank placeholder image; PNG imports keep their artwork.
 */
export function importCharacter(bytes: Uint8Array, filename: string): CharacterDetail {
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
