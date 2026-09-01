/**
 * Backing the whole library up as one zip.
 *
 * The data directory has always been one portable unit — this is the button that admits it.
 * There is no restore here on purpose: an unzipped backup satisfies looksLikeLibrary(), so
 * pointing Data location at it adopts it, and that path is already built and tested. Adding
 * a second, destructive way to put a library back would be the only part of this feature
 * capable of losing data.
 *
 * Two things make the archive a real snapshot rather than a copy of some files:
 *
 *   1. chats.db is taken with VACUUM INTO, not read off disk. In WAL mode most of the
 *      database can be sitting in chats.db-wal, so copying the one file loses nearly
 *      everything. VACUUM INTO gives a consistent, compacted copy without closing the live
 *      connection or touching its journal mode — which is why closeDatabase() is not reused
 *      here: its settle() flips the *live* database to journal_mode = DELETE.
 *   2. The archive is built to a temp file and served from there, rather than streamed
 *      straight out of the walk. Bun.serve buffers a JS ReadableStream body in full — a
 *      400 MB library measured 2.1 GB of RSS and the producer finished twelve times faster
 *      than delivery, so there is no backpressure to lean on. Draining into a FileSink puts
 *      that backpressure back: peak memory becomes one file, Bun.file then serves the
 *      result in constant memory, and the browser gets a content-length and therefore a
 *      real progress bar. Disk is the cheaper thing to spend here than RAM.
 *
 * Between them those give the property a backup needs most: everything that can fail has
 * failed before the Response exists. Once a 200 is on the wire a throw can only produce a
 * truncated archive, and a truncated backup is worse than a refused one.
 */

import { randomBytes } from 'node:crypto';
import { type Dirent, readdirSync, statSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupManifest, BackupPlan } from '../../shared/types/backup.ts';
import { getDb, SCHEMA_VERSION } from './db.ts';
import { drainLocks } from './fs.ts';
import { isIgnoredEntry } from './location.ts';
import { PATHS, PROJECT_ROOT } from './paths.ts';
import { type ZipSource, zipStream } from './zip.ts';

/** A failure the route can turn straight into a status code, like RelocateError. */
export class BackupError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BackupError';
    this.status = status;
  }
}

export interface BackupOptions {
  /** API keys are left out unless the user explicitly asks for them. */
  secrets: boolean;
}

const EMPTY = new Uint8Array(0);

/** Names both temp files a backup makes, so a sweep can recognise its own leftovers. */
const TEMP_PREFIX = 'wackchatter-backup-';

/* ------------------------------------------------------------------------------------- *
 * What goes in
 * ------------------------------------------------------------------------------------- */

/** An atomicWrite temporary mid-rename: `<name>.<12 hex chars>.tmp`. See fs.ts. */
const TEMP_SUFFIX = /\.[0-9a-f]{12}\.tmp$/;

export type ExclusionReason = 'noise' | 'secrets' | 'temp' | 'db' | 'manifest';

/**
 * Why a path is left out of the archive, or null to include it.
 *
 * `rel` is the path relative to the library root, forward-slashed. Everything not named
 * here is included — backups/ and backgrounds/ especially, because a backup that leaves
 * things out is not a backup.
 */
export function backupExclusion(rel: string, options: BackupOptions): ExclusionReason | null {
  const name = rel.slice(rel.lastIndexOf('/') + 1);

  if (isIgnoredEntry(name)) return 'noise';
  if (TEMP_SUFFIX.test(name)) return 'temp';
  if (name.startsWith('.wc-write-probe-')) return 'temp';

  /*
   * Root-level matches only, and that scoping is load-bearing: a card called "backup.json"
   * inside a character folder is the user's file, while the one at the root is ours.
   *
   * Both synthesised entries have to be excluded from the walk that could rediscover them.
   * chats.db is the obvious one. backup.json is the subtle one — restoring means unzipping
   * and adopting, so a restored library carries our manifest at its root forever, and
   * backing *that* up again would write two entries with the same name.
   */
  if (rel === 'secrets.json') return options.secrets ? null : 'secrets';
  if (rel === 'backup.json') return 'manifest';
  // The sidecar is -wal under WAL and -journal in a cloud folder, where openDatabase picks
  // journal_mode = DELETE instead. Match the prefix rather than enumerate them.
  if (rel === 'chats.db' || rel.startsWith('chats.db-')) return 'db';

  return null;
}

interface Walked {
  sources: ZipSource[];
  files: number;
  bytes: number;
}

/**
 * Every file under the library, as archive sources rooted at `stem`.
 *
 * Recursive, because character folders nest arbitrarily and a flat readdir silently drops
 * every card inside one. Directory entries are emitted so an empty folder the user made
 * survives the round trip — settings reference those names in collapsedCharacterFolders.
 */
function walkLibrary(root: string, stem: string, options: BackupOptions): Walked {
  const sources: ZipSource[] = [];
  let files = 0;
  let bytes = 0;

  const visit = (dir: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // One unreadable folder is worth skipping. It is not worth failing the whole backup.
      return;
    }

    // Sorted by code unit rather than locale, so two backups of an unchanged library agree
    // with each other on every machine — localeCompare's order is host-dependent.
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (backupExclusion(childRel, options)) continue;

      const full = join(dir, entry.name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(full);
      } catch {
        // Vanished mid-walk.
        continue;
      }

      if (entry.isDirectory()) {
        sources.push({ name: `${stem}/${childRel}/`, mtime: stats.mtime, read: async () => EMPTY });
        visit(full, childRel);
        continue;
      }
      /*
       * Dirent's predicates do not follow links, so a symlink answers false to both and
       * lands here — which is what we want. Following one would either archive whatever it
       * points at (a link into ~/.ssh is a library backup that exfiltrates a private key)
       * or loop forever on a cycle. Sockets and fifos have nothing to archive either.
       */
      if (!entry.isFile()) continue;

      files += 1;
      bytes += stats.size;
      sources.push({
        name: `${stem}/${childRel}`,
        mtime: stats.mtime,
        // Carries secrets.json's 0600 through the archive, when it is included at all.
        mode: stats.mode,
        read: () => readFile(full),
      });
    }
  };

  visit(root, '');
  return { sources, files, bytes };
}

/* ------------------------------------------------------------------------------------- *
 * Naming
 * ------------------------------------------------------------------------------------- */

/**
 * The archive's name, and the single folder inside it.
 *
 * Everything sits under one top-level folder so that `unzip` in a terminal — which, unlike
 * Finder and Explorer, wraps nothing — cannot scatter a library across someone's Downloads.
 */
export function backupStem(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `wackchatter-library-${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/* ------------------------------------------------------------------------------------- *
 * In-flight backups
 * ------------------------------------------------------------------------------------- */

/**
 * Backups being built right now, by start time.
 *
 * The data folder must not move while one is: the walk reads the library a file at a time,
 * and a move underneath it truncates the archive. The window is deliberately generation
 * only — once the temp archive is complete, the bytes are captured and a relocate can no
 * longer hurt it, so holding the slot through the download would refuse moves for no gain.
 *
 * Entries older than the cap are ignored rather than trusted, for the same reason
 * generate.ts does it: one leaked entry would block the folder from ever moving again.
 */
const inFlight = new Set<{ started: number }>();
const STALE_AFTER_MS = 30 * 60 * 1000;

export function activeBackups(): number {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const entry of inFlight) {
    if (entry.started < cutoff) inFlight.delete(entry);
  }
  return inFlight.size;
}

/** Mark a backup as started. The returned function is safe to call more than once. */
export function trackBackup(): () => void {
  const entry = { started: Date.now() };
  inFlight.add(entry);
  return () => {
    inFlight.delete(entry);
  };
}

/* ------------------------------------------------------------------------------------- *
 * Planning and running
 * ------------------------------------------------------------------------------------- */

/** Cached for the process lifetime: a version change means a restart. Same as version.ts. */
let appVersion: string | null = null;

async function resolveAppVersion(): Promise<string> {
  if (appVersion) return appVersion;
  try {
    const pkg = (await Bun.file(join(PROJECT_ROOT, 'package.json')).json()) as { version?: string };
    appVersion = pkg.version ?? '0.0.0';
  } catch {
    appVersion = '0.0.0';
  }
  return appVersion;
}

function databaseBytes(): number {
  try {
    return statSync(PATHS.db).size;
  } catch {
    return 0;
  }
}

/**
 * What a backup would contain, without building one.
 *
 * Cheap enough to run every time the panel opens, and it is also the preflight: the errors
 * a user can actually hit surface here as JSON, where the section can render them, rather
 * than as a failed download the page never hears about.
 */
export function planBackup(options: BackupOptions, now: Date = new Date()): BackupPlan {
  const stem = backupStem(now);
  const walked = walkLibrary(PATHS.root, stem, options);
  return {
    filename: `${stem}.zip`,
    stem,
    // Plus the database snapshot and the manifest, neither of which is on disk to be walked.
    files: walked.files + 2,
    bytes: walked.bytes + databaseBytes(),
    includesSecrets: options.secrets,
  };
}

/**
 * Sweep temp archives a previous run left behind.
 *
 * The one hole in the cleanup below is a `kill -9` between writing an archive and serving
 * it. Cheap to sweep on the way in, and an hour is far longer than any download takes over
 * loopback, so this can never delete one that is still being read.
 */
function sweepStaleArchives(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(tmpdir(), name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // Someone else's to clean up, or already gone.
      }
    }
  } catch {
    // An unreadable temp directory is not worth failing a backup over.
  }
}

/**
 * Drain the archive to disk, one entry at a time.
 *
 * `await sink.flush()` is what makes this bounded: it is the backpressure that Bun.serve
 * does not apply to a stream body, so the walk advances at the speed the disk accepts
 * bytes rather than as fast as it can read them.
 */
async function writeArchive(sources: ZipSource[], path: string): Promise<number> {
  const sink = Bun.file(path).writer();
  let bytes = 0;
  try {
    for await (const chunk of zipStream(sources)) {
      sink.write(chunk);
      await sink.flush();
      bytes += chunk.length;
    }
  } finally {
    await sink.end();
  }
  return bytes;
}

/**
 * Build the archive.
 *
 * Ordered so that every failure mode lands before the caller has a Response to send: drain,
 * snapshot, walk, write. The caller gets a finished file and a way to throw it away.
 */
export async function startBackup(
  options: BackupOptions,
): Promise<{ plan: BackupPlan; path: string; dispose: () => void }> {
  // An atomicWrite in flight has its bytes in a temp sibling that has not been renamed into
  // place yet, so walking now would archive the old file and miss the new one. Same trade as
  // relocate.ts: making the user retry beats a quietly wrong copy of their library.
  if (!(await drainLocks(5000))) {
    throw new BackupError(
      'WackChatter is still finishing a write to your library. Try again in a moment.',
      503,
    );
  }

  sweepStaleArchives();

  const root = PATHS.root;
  const stem = backupStem();
  // Random, because VACUUM INTO refuses to overwrite an existing file — which is a feature
  // here, since a collision would otherwise mean shipping someone else's database.
  const token = randomBytes(8).toString('hex');
  const snapshot = join(tmpdir(), `${TEMP_PREFIX}${token}.db`);
  const archive = join(tmpdir(), `${TEMP_PREFIX}${token}.zip`);
  const discard = (path: string): void => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, which is the expected case.
    }
  };

  try {
    getDb().query('VACUUM INTO ?').run(snapshot);
  } catch (error) {
    // A full disk lands here, as a clean error rather than half an archive.
    throw new BackupError(
      `The chat database could not be copied into ${tmpdir()}: ${(error as Error).message}`,
      500,
    );
  }

  const release = trackBackup();
  try {
    const walked = walkLibrary(root, stem, options);
    const snapshotStats = statSync(snapshot);

    const plan: BackupPlan = {
      filename: `${stem}.zip`,
      stem,
      files: walked.files + 2,
      bytes: walked.bytes + snapshotStats.size,
      includesSecrets: options.secrets,
    };

    const manifest: BackupManifest = {
      ...plan,
      app: 'wackchatter',
      kind: 'library-backup',
      version: 1,
      created: new Date().toISOString(),
      appVersion: await resolveAppVersion(),
      schemaVersion: SCHEMA_VERSION,
      source: root,
    };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

    const sources: ZipSource[] = [
      { name: `${stem}/backup.json`, mtime: new Date(), read: async () => manifestBytes },
      {
        name: `${stem}/chats.db`,
        mtime: snapshotStats.mtime,
        mode: 0o100644,
        read: () => readFile(snapshot),
      },
      ...walked.sources,
    ];

    try {
      await writeArchive(sources, archive);
    } catch (error) {
      discard(archive);
      throw new BackupError(
        `The backup could not be written to ${tmpdir()}: ${(error as Error).message}`,
        500,
      );
    }

    return { plan, path: archive, dispose: () => discard(archive) };
  } finally {
    // The snapshot exists only to be archived, and by here it either has been or never will
    // be. The slot goes back at the same moment: the library is no longer being read.
    discard(snapshot);
    release();
  }
}
