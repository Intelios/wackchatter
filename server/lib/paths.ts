/**
 * Data directory resolution and creation.
 *
 * Everything the user owns lives under one directory so it can be backed up or moved
 * wholesale. Override with WC_DATA_DIR.
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(serverDir, '../..');

export const DATA_DIR = process.env.WC_DATA_DIR
  ? resolve(process.env.WC_DATA_DIR)
  : join(PROJECT_ROOT, 'data');

export const PATHS = {
  root: DATA_DIR,
  characters: join(DATA_DIR, 'characters'),
  presets: join(DATA_DIR, 'presets'),
  lorebooks: join(DATA_DIR, 'lorebooks'),
  personas: join(DATA_DIR, 'personas'),
  personaAvatars: join(DATA_DIR, 'personas', 'avatars'),
  backgrounds: join(DATA_DIR, 'backgrounds'),
  /** Deleted chats wait here, restorable, until pruned by the retention cap. */
  backups: join(DATA_DIR, 'backups'),
  settings: join(DATA_DIR, 'settings.json'),
  secrets: join(DATA_DIR, 'secrets.json'),
  db: join(DATA_DIR, 'chats.db'),
} as const;

export function ensureDataDirs(): void {
  for (const dir of [
    PATHS.root,
    PATHS.characters,
    PATHS.presets,
    PATHS.lorebooks,
    PATHS.personas,
    PATHS.personaAvatars,
    PATHS.backgrounds,
    PATHS.backups,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Control characters (0x00-0x1F and 0x7F) are illegal in filenames on every platform. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
/** Reserved or path-significant characters. */
const ILLEGAL_CHARS = /[/\\?%*:|"<>]/g;
/** Windows reserved device names, which cannot be used even with an extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Make a user-supplied name safe to use as a filename, and reject anything that tries
 * to escape its directory. Returns null if nothing usable survives.
 */
export function sanitizeFilename(name: string): string | null {
  const cleaned = name
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_CHARS, '')
    // Trailing dots and spaces are silently dropped by Windows, which would let
    // "foo." and "foo" collide.
    .replace(/[. ]+$/, '')
    // Leading dots make the file hidden on Unix. Stripping the separators out of
    // "../../escaped" leaves "....escaped", which is safely inside the data directory but
    // invisible to the user in a file browser or a plain `ls`.
    .replace(/^\.+/, '')
    .trim();

  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  if (RESERVED_NAMES.test(cleaned)) return null;
  return cleaned.slice(0, 200);
}

/**
 * Resolve `name` inside `dir`, refusing to escape it.
 * Guards every path that comes from a request.
 */
export function safeJoin(dir: string, name: string): string | null {
  const safe = sanitizeFilename(name);
  if (!safe) return null;

  const base = resolve(dir);
  const full = resolve(base, safe);
  if (full !== base && !full.startsWith(`${base}/`)) return null;
  if (!isAbsolute(full)) return null;
  return full;
}

/** Find a filename that isn't taken, appending 1, 2, 3... as ST does (no separator). */
export function uniqueName(base: string, exists: (candidate: string) => boolean): string {
  if (!exists(base)) return base;
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base}${i}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not find a free filename for "${base}".`);
}
