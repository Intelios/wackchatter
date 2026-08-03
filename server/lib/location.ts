/**
 * Where the data directory lives, and how the user moves it.
 *
 * The library defaults to <repo>/data, which is a poor place to keep something you want to
 * back up or sync. So the location is configurable — but the setting cannot live in
 * data/settings.json, because that file is inside the thing being moved. It lives in a
 * pointer file in the OS config directory instead, which survives re-cloning or upgrading
 * the app.
 *
 * Precedence: WC_DATA_DIR beats the pointer file, which beats <repo>/data. The env var wins
 * outright and locks the UI, so a scripted or containerised install is never fighting a
 * setting someone clicked six months ago.
 *
 * Import direction is one-way: this module imports paths.ts, never the reverse. paths.ts
 * starts at the env-or-default root and server/index.ts calls initDataLocation() at boot to
 * apply the pointer.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type {
  DataDirSource,
  LibraryStats,
  LocationCode,
  LocationVerdict,
  LocationWarning,
  UnreachableReason,
} from '../../shared/types/location.ts';
import { atomicWrite } from './fs.ts';
import { DEFAULT_DATA_DIR, MARKER_FILENAME, PATHS, PROJECT_ROOT, setDataDir } from './paths.ts';

export type { LocationVerdict, LocationWarning };

export interface LocationPointer {
  version: 1;
  dataDir: string;
  updated: string;
}

export interface ResolvedLocation {
  dir: string;
  source: DataDirSource;
  /** Set when a pointer exists but its directory is unusable; dir/source have fallen back. */
  unreachable: string | null;
  reason: UnreachableReason | null;
}

/**
 * The OS config directory.
 *
 * env, platform and home are injected rather than read directly so all three branches are
 * testable in one run — the alternative is two of them never being exercised.
 */
export function configDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'WackChatter');
  }
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'WackChatter');
  }
  // `||` not `??`: XDG treats an empty value as unset.
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'wackchatter');
}

export function pointerPath(dir: string = configDir()): string {
  return join(dir, 'location.json');
}

/**
 * Read the pointer, or null if there isn't a usable one.
 *
 * This runs before anything else at boot, so it must never throw: a truncated or hand-edited
 * file has to degrade to "no pointer" rather than stopping the app from starting.
 */
export function readPointer(path: string = pointerPath()): LocationPointer | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;

    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return null;
    if (typeof record.dataDir !== 'string' || !record.dataDir.trim()) return null;

    return {
      version: 1,
      dataDir: resolve(record.dataDir),
      updated: typeof record.updated === 'string' ? record.updated : '',
    };
  } catch {
    return null;
  }
}

/**
 * Record the chosen directory.
 *
 * Choosing the default *deletes* the pointer rather than writing it: absence is the honest
 * representation of "wherever the app is", and it means resetting to default needs no
 * separate route or flag.
 */
export async function writePointer(dataDir: string, path: string = pointerPath()): Promise<void> {
  const target = resolve(dataDir);
  if (target === DEFAULT_DATA_DIR) {
    rmSync(path, { force: true });
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  const pointer: LocationPointer = {
    version: 1,
    dataDir: target,
    updated: new Date().toISOString(),
  };
  await atomicWrite(path, `${JSON.stringify(pointer, null, 2)}\n`);
}

/**
 * Entries that don't count as "someone is using this folder" — droppings from file managers
 * and sync clients, which are present in almost every real directory a user would pick.
 */
const IGNORED_ENTRIES = new Set([
  '.DS_Store',
  '.localized',
  'Thumbs.db',
  'desktop.ini',
  '.dropbox',
  '.dropbox.attr',
  '.icloud',
]);

/** Directory contents, ignoring the droppings above. Unreadable reads as empty. */
export function meaningfulEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !IGNORED_ENTRIES.has(name));
  } catch {
    return [];
  }
}

export function hasMarker(dir: string): boolean {
  return existsSync(join(dir, MARKER_FILENAME));
}

/**
 * A library that predates the marker file — hand-copied following the old README advice, or
 * left over from an earlier build. Adopting one writes the marker.
 */
export function looksLikeLibrary(dir: string): boolean {
  if (existsSync(join(dir, 'chats.db'))) return true;
  return existsSync(join(dir, 'characters')) && existsSync(join(dir, 'presets'));
}

/** Where the data directory should be, given the env, the pointer file, and what's on disk. */
export function resolveDataDir(path: string = pointerPath()): ResolvedLocation {
  const override = process.env.WC_DATA_DIR?.trim();
  if (override) {
    return { dir: resolve(override), source: 'env', unreachable: null, reason: null };
  }

  const pointer = readPointer(path);
  if (!pointer) {
    return { dir: DEFAULT_DATA_DIR, source: 'default', unreachable: null, reason: null };
  }

  const fallback = (reason: UnreachableReason): ResolvedLocation => ({
    dir: DEFAULT_DATA_DIR,
    source: 'default',
    unreachable: pointer.dataDir,
    reason,
  });

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(pointer.dataDir);
  } catch {
    // An unplugged drive, or a cloud folder that hasn't synced yet. Fall back to the default
    // and leave the pointer file alone: reconnecting the folder must be all it takes to get
    // the library back. Creating the directory here instead would put an empty library on
    // the root filesystem and then shadow the real one when the volume returns.
    return fallback('missing');
  }
  if (!stats.isDirectory()) return fallback('not-a-directory');

  // Empty is fine — ensureDataDirs seeds it. Non-empty with nothing that identifies it as
  // ours is not: someone hand-edited the pointer at their Documents folder, and scribbling
  // eight directories and a database into it would be the wrong kind of helpful.
  if (
    !hasMarker(pointer.dataDir) &&
    !looksLikeLibrary(pointer.dataDir) &&
    meaningfulEntries(pointer.dataDir).length > 0
  ) {
    return fallback('foreign-contents');
  }

  return { dir: pointer.dataDir, source: 'pointer', unreachable: null, reason: null };
}

/* ------------------------------------------------------------------------------------- *
 * Validating a directory the user picked
 * ------------------------------------------------------------------------------------- */

const WIN32 = process.platform === 'win32';

function samePath(a: string, b: string): boolean {
  return WIN32 ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Containment by whole path segment, so /usr never matches /usrfoo. */
function pathStartsWith(child: string, parent: string): boolean {
  if (samePath(child, parent)) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return WIN32 ? child.toLowerCase().startsWith(prefix.toLowerCase()) : child.startsWith(prefix);
}

/**
 * Resolve symlinks as far as the path exists, then re-append what doesn't.
 *
 * Every containment check below has to run on the result, or a symlink like ~/data -> /
 * walks straight through all of them. `.native` rather than plain realpathSync because on
 * Windows it also expands 8.3 short names (PROGRA~1), which would otherwise defeat prefix
 * matching just as effectively.
 */
export function realpathBestEffort(target: string): string {
  let head = resolve(target);
  const tail: string[] = [];

  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(head);
      // dirname('/') === '/', so this is what terminates the walk.
      if (parent === head) return resolve(target);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Directories where a library has no business living. Not an exhaustive list of things that
 * would break — the writability probe catches most of those — but the ones where succeeding
 * would be worse than failing.
 *
 * /var is deliberately absent: on macOS the temp directory resolves under /private/var, and
 * a scratch library there is a choice the user is allowed to make (it gets a warning below).
 * Nobody can write to /var proper anyway, so the probe covers it.
 */
const SYSTEM_DIRS = WIN32
  ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
  : [
      '/System',
      '/usr',
      '/bin',
      '/sbin',
      '/etc',
      '/dev',
      '/Applications',
      '/opt',
      '/Library',
      '/proc',
      '/boot',
    ];

/**
 * Cloud-sync providers, matched per path segment.
 *
 * Segment matching, not substring: ~/Documents/Dropboxes/x is somebody's ordinary folder and
 * warning about it would train the user to ignore the warning that matters. A bare "Sync"
 * segment is excluded for the same reason.
 */
const CLOUD_PROVIDERS: Array<[provider: string, matches: (segment: string) => boolean]> = [
  ['Dropbox', (s) => s === 'dropbox' || s.startsWith('dropbox (') || s.startsWith('dropbox-')],
  ['iCloud Drive', (s) => s === 'mobile documents' || s === 'icloud drive'],
  ['OneDrive', (s) => s === 'onedrive' || s.startsWith('onedrive -') || s.startsWith('onedrive-')],
  [
    'Google Drive',
    (s) =>
      s === 'google drive' ||
      s === 'googledrive' ||
      s === 'my drive' ||
      s.startsWith('googledrive-'),
  ],
  ['pCloud', (s) => s === 'pcloud' || s === 'pclouddrive'],
  ['Nextcloud', (s) => s === 'nextcloud'],
  ['ownCloud', (s) => s === 'owncloud'],
  ['Box', (s) => s === 'box' || s === 'box sync'],
  ['MEGA', (s) => s === 'mega' || s === 'megasync'],
  ['Sync.com', (s) => s === 'sync.com'],
  ['Syncthing', (s) => s === 'syncthing'],
];

/**
 * macOS mounts every FileProvider-based client under one directory, so ~/Library/CloudStorage
 * means "synced" without saying by whom. The named providers win when a later segment
 * identifies one — ~/Library/CloudStorage/OneDrive-Corp should say OneDrive.
 */
const GENERIC_CLOUD_SEGMENT = 'cloudstorage';

/** The provider whose folder this path is inside, or null. */
export function detectCloudProvider(target: string): string | null {
  const segments = target
    .split(/[/\\]+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);

  for (const segment of segments) {
    for (const [provider, matches] of CLOUD_PROVIDERS) {
      if (matches(segment)) return provider;
    }
  }
  return segments.includes(GENERIC_CLOUD_SEGMENT) ? 'a cloud folder' : null;
}

const CLOUD_MESSAGE =
  'A sync client can copy chats.db while it is being written, or let two machines write it ' +
  'at once, and either corrupts it. WackChatter turns off SQLite\u2019s write-ahead log here to ' +
  'narrow the risk, but run it from one machine at a time and let the folder finish syncing ' +
  'before you quit.';

const SECRETS_MESSAGE =
  'Your API keys live in secrets.json inside this folder, so they will be uploaded to this ' +
  'service. They are no longer only on your machine.';

export function locationWarnings(target: string): LocationWarning[] {
  const warnings: LocationWarning[] = [];

  const provider = detectCloudProvider(target);
  if (provider) {
    warnings.push({ kind: 'cloud', message: `Inside ${provider}. ${CLOUD_MESSAGE}` });
    warnings.push({ kind: 'secrets', message: SECRETS_MESSAGE });
  } else if (target.startsWith('\\\\')) {
    warnings.push({
      kind: 'network-volume',
      message: `On a network share. ${CLOUD_MESSAGE}`,
    });
  }

  if (pathStartsWith(realpathBestEffort(target), realpathBestEffort(tmpdir()))) {
    warnings.push({
      kind: 'temp-dir',
      message: 'Inside the system temporary folder, which the OS empties periodically.',
    });
  }
  return warnings;
}

/** Can we actually write here? Probe rather than ask — see the comment inside. */
function probeWritable(dir: string): boolean {
  /*
   * accessSync(dir, W_OK) checks POSIX mode bits against the effective uid, which is not the
   * same question. It reports success on a read-only mount (the bits say writable, write(2)
   * returns EROFS), on ACL-governed paths, on SMB and exFAT volumes, and it means very little
   * on Windows. Writing a byte is the only answer that is actually true.
   */
  const probe = join(dir, `.wc-write-probe-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(probe, '');
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // Never existed, or vanished under us. Either way there is nothing to clean up.
    }
  }
}

function countEntries(dir: string, predicate: (name: string) => boolean): number {
  try {
    return readdirSync(dir).filter(predicate).length;
  } catch {
    return 0;
  }
}

function newestMtime(paths: string[]): number | null {
  let newest: number | null = null;
  for (const path of paths) {
    try {
      const mtime = statSync(path).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // Absent files simply do not contribute.
    }
  }
  return newest;
}

/** Summarise a library so the UI can say what it is about to adopt. */
export function readLibraryStats(dir: string): LibraryStats {
  return {
    markerMissing: !hasMarker(dir),
    characters: countEntries(join(dir, 'characters'), (name) =>
      name.toLowerCase().endsWith('.png'),
    ),
    presets: countEntries(join(dir, 'presets'), (name) => name.toLowerCase().endsWith('.json')),
    lorebooks: countEntries(join(dir, 'lorebooks'), (name) => name.toLowerCase().endsWith('.json')),
    hasChats: existsSync(join(dir, 'chats.db')),
    modified: newestMtime([
      join(dir, 'chats.db'),
      join(dir, 'settings.json'),
      join(dir, 'characters'),
    ]),
  };
}

function freeBytesAt(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail ?? stats.bfree) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function deviceOf(path: string): number | null {
  try {
    return statSync(path).dev;
  } catch {
    return null;
  }
}

/** The nearest ancestor of `target` that exists, for probing device and free space. */
function existingAncestor(target: string): string {
  let head = target;
  for (;;) {
    if (existsSync(head)) return head;
    const parent = dirname(head);
    if (parent === head) return head;
    head = parent;
  }
}

const reject = (code: LocationCode, message: string, path: string): LocationVerdict => ({
  ok: false,
  code,
  message,
  path,
});

/**
 * Decide whether the user's chosen directory can hold their library, and what is already in
 * it. Pure inspection — never creates, moves or deletes anything.
 *
 * Order matters: the symlink resolution in step 2 has to happen before any containment check,
 * and occupancy is last because it is the only one that reads the directory's contents.
 */
export function inspectLocation(input: string, currentRoot: string = PATHS.root): LocationVerdict {
  const raw = input.trim();
  if (!raw || raw.includes('\0')) {
    return reject('invalid', 'Enter a folder path.', raw);
  }
  if (!isAbsolute(raw)) {
    return reject('not-absolute', 'Use a full path, starting from the top of the drive.', raw);
  }

  const path = realpathBestEffort(raw);
  const current = realpathBestEffort(currentRoot);

  if (dirname(path) === path) {
    return reject(
      'filesystem-root',
      'That is the top of the drive. Pick a folder inside it.',
      path,
    );
  }
  for (const system of SYSTEM_DIRS) {
    if (pathStartsWith(path, system)) {
      return reject('system-dir', `${system} belongs to the operating system.`, path);
    }
  }
  if (samePath(path, realpathBestEffort(homedir()))) {
    return reject(
      'home-dir',
      'That is your home folder itself. Pick a folder inside it, so the library stays together.',
      path,
    );
  }

  // Anything under the checkout is fair game for `git clean`, except data/ which is where the
  // library lives by default and is therefore the legitimate reset target.
  if (
    pathStartsWith(path, realpathBestEffort(PROJECT_ROOT)) &&
    !samePath(path, realpathBestEffort(DEFAULT_DATA_DIR))
  ) {
    return reject(
      'inside-project',
      'That is inside the app\u2019s own folder, where an update could delete it.',
      path,
    );
  }

  if (samePath(path, current)) {
    return {
      ok: true,
      kind: 'same',
      path,
      library: readLibraryStats(path),
      sameDevice: true,
      warnings: locationWarnings(path),
      freeBytes: freeBytesAt(existingAncestor(path)),
    };
  }
  // Copying a directory into itself, or onto its own parent, recurses forever.
  if (pathStartsWith(path, current) || pathStartsWith(current, path)) {
    return reject(
      'nested',
      `${path} and your current folder ${current} are inside one another, so one cannot hold the other.`,
      path,
    );
  }

  const parent = dirname(path);
  if (!existsSync(parent)) {
    return reject('parent-missing', `${parent} does not exist. Create it first.`, path);
  }
  if (!statSync(parent).isDirectory()) {
    return reject('parent-missing', `${parent} is a file, not a folder.`, path);
  }

  const exists = existsSync(path);
  if (exists && !statSync(path).isDirectory()) {
    return reject('not-a-directory', 'That is a file, not a folder.', path);
  }
  // At most the leaf gets created — never a chain of parents, which is how a typo or an
  // unmounted drive turns into an empty library in the wrong place.
  if (!probeWritable(exists ? path : parent)) {
    return reject('not-writable', `${exists ? path : parent} cannot be written to.`, path);
  }

  const marker = exists && hasMarker(path);
  const legacy = exists && looksLikeLibrary(path);
  const entries = exists ? meaningfulEntries(path) : [];

  if (!marker && !legacy && entries.length > 0) {
    const sample = entries.slice(0, 3).join(', ');
    return reject(
      'occupied',
      `That folder already holds other files (${sample}${entries.length > 3 ? ', \u2026' : ''}). ` +
        'Pick an empty folder, or one that already holds a WackChatter library.',
      path,
    );
  }

  return {
    ok: true,
    kind: marker || legacy ? 'library' : 'empty',
    path,
    library: marker || legacy ? readLibraryStats(path) : null,
    sameDevice: deviceOf(existingAncestor(path)) === deviceOf(current),
    warnings: locationWarnings(path),
    freeBytes: freeBytesAt(existingAncestor(path)),
  };
}

const UNREACHABLE_DETAIL: Record<UnreachableReason, string> = {
  missing: 'it is not there — an unplugged drive, or a folder that has not synced yet',
  'not-a-directory': 'it is a file, not a folder',
  'foreign-contents': 'it holds files that are not a WackChatter library',
};

/**
 * Apply the resolved location. Called at boot, before anything creates or reads a data file.
 *
 * Safe to call more than once, which `bun --hot` relies on: a hot reload re-runs every module
 * body, resetting paths.ts to the env-or-default root, and this call is what puts it back.
 */
export function initDataLocation(): ResolvedLocation {
  const resolved = resolveDataDir();
  setDataDir(resolved.dir);

  if (resolved.unreachable && resolved.reason) {
    console.error(
      `[wackchatter] Your data folder "${resolved.unreachable}" cannot be used: ` +
        `${UNREACHABLE_DETAIL[resolved.reason]}.\n` +
        `[wackchatter] Using ${resolved.dir} instead. The setting has not been changed — ` +
        'reconnect the folder and restart to go back to it.',
    );
  }

  // One line, every boot. If a synced library ever does get corrupted, the evidence should
  // already be in the terminal rather than something we only mention in a panel they closed.
  const provider = detectCloudProvider(resolved.dir);
  if (provider) {
    console.warn(
      `[wackchatter] Your data folder is inside ${provider}. Run WackChatter from one ` +
        'machine at a time, and let the folder finish syncing before you quit.',
    );
  }
  return resolved;
}
