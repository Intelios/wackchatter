/**
 * Data directory resolution and creation.
 *
 * Everything the user owns lives under one directory so it can be backed up or moved
 * wholesale. Which directory that is gets decided at boot by lib/location.ts — WC_DATA_DIR
 * first, then the pointer file, then <repo>/data — and the user can move it while the
 * server runs.
 *
 * This module deliberately does not read the pointer file itself: location.ts imports
 * paths.ts, never the reverse. Until initDataLocation() runs, PATHS names the env override
 * or the default.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(serverDir, '../..');
export const DEFAULT_DATA_DIR = join(PROJECT_ROOT, 'data');

/** Names a directory as a WackChatter library, so one can be told from a stranger's folder. */
export const MARKER_FILENAME = '.wackchatter';

export interface DataPaths {
  root: string;
  characters: string;
  presets: string;
  lorebooks: string;
  personas: string;
  personaAvatars: string;
  backgrounds: string;
  /** Deleted chats wait here, restorable, until pruned by the retention cap. */
  backups: string;
  settings: string;
  secrets: string;
  db: string;
  marker: string;
}

function buildPaths(dataDir: string): DataPaths {
  return {
    root: dataDir,
    characters: join(dataDir, 'characters'),
    presets: join(dataDir, 'presets'),
    lorebooks: join(dataDir, 'lorebooks'),
    personas: join(dataDir, 'personas'),
    personaAvatars: join(dataDir, 'personas', 'avatars'),
    backgrounds: join(dataDir, 'backgrounds'),
    backups: join(dataDir, 'backups'),
    settings: join(dataDir, 'settings.json'),
    secrets: join(dataDir, 'secrets.json'),
    db: join(dataDir, 'chats.db'),
    marker: join(dataDir, MARKER_FILENAME),
  };
}

const mutablePaths = buildPaths(
  process.env.WC_DATA_DIR ? resolve(process.env.WC_DATA_DIR) : DEFAULT_DATA_DIR,
);

/**
 * A LIVE VIEW of the current data directory, not a snapshot.
 *
 * setDataDir rewrites this object in place, so the ~60 sites that read PATHS.x at call time
 * follow the move with no changes of their own. The corollary is a rule with teeth: never
 * destructure PATHS, and never capture PATHS.x into a module-level const. Doing either pins
 * a path to whatever the root was at import time — which is exactly the bug the old
 * BLANK_AVATAR_PATH had, and it would survive a move silently.
 *
 * Readonly here means immutable *to consumers*. The module keeps a mutable alias.
 */
export const PATHS: Readonly<DataPaths> = mutablePaths;

/** Point every path at a new root. Callers must reset anything memoised from the old one. */
export function setDataDir(dataDir: string): void {
  Object.assign(mutablePaths, buildPaths(resolve(dataDir)));
}

/**
 * Stamp a directory as a WackChatter library.
 *
 * Idempotent, and `created` is never rewritten — it is the only field here with any history
 * in it. A corrupt marker is replaced rather than trusted. Written with a plain write rather
 * than through fs.ts: a torn marker is self-healing (the next call rewrites it) and keeping
 * this module free of local imports keeps the dependency graph acyclic.
 */
export function writeMarker(dir: string): void {
  const path = join(dir, MARKER_FILENAME);
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object' && 'created' in parsed) return;
    } catch {
      // Unreadable or not JSON — fall through and replace it.
    }
  }
  const marker = { app: 'wackchatter', version: 1, created: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
}

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
  // Every existing library picks up a marker here at next boot, so nothing needs migrating.
  writeMarker(PATHS.root);
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
