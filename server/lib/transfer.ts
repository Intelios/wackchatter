/**
 * Moving a library from one directory to another.
 *
 * The whole operation is built around one ordering rule, because getting it wrong loses
 * data in a way no error message can undo:
 *
 *   The pointer write is the commit point, and it goes immediately after the last thing that
 *   changes where the data physically is. Before it, roll back. After it, never roll back —
 *   fail loudly and ask for a restart, because a restart reads the pointer and lands right.
 *
 * So this module does not write the pointer and does not touch the source until told to.
 * moveLibrary puts the data in place and hands back two closures: `undo`, valid only until
 * the caller commits, and `finish`, called only once it has.
 */

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Rollback } from './rollback.ts';

export interface TransferOutcome {
  strategy: 'rename' | 'copy';
  warnings: string[];
  /** Reverse the move. Only valid before the pointer is committed. */
  undo: Rollback;
  /**
   * Dispose of the source directory now that the new location is authoritative. Returns
   * where the old library was left, or null if there is nothing to keep.
   */
  finish: () => Promise<string | null>;
}

/**
 * Refuse to move a database that something still has open.
 *
 * closeDatabase() leaves exactly one file behind, so a sidecar reappearing here means another
 * connection recreated it — a second WackChatter pointed at the same folder, most likely. A
 * behavioural check rather than trust in an API call, and it is what makes "we never copy a
 * half-written database" an actual guarantee rather than an intention.
 */
function assertDatabaseReleased(source: string): void {
  const db = join(source, 'chats.db');
  if (!existsSync(db)) return;

  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${db}${suffix}`)) {
      throw new Error(
        `The chat database is still open (chats.db${suffix} came back), so moving it now ` +
          'could corrupt your history. Close any other copy of WackChatter using this folder, ' +
          'then restart and try again.',
      );
    }
  }
}

function deviceOf(path: string): number | null {
  try {
    return statSync(path).dev;
  } catch {
    return null;
  }
}

/**
 * A rename is one atomic syscall that preserves modes, timestamps and extended attributes,
 * and leaves nothing to verify. It only works within one filesystem and onto a name that
 * does not exist yet.
 *
 * Split out from the filesystem so the decision is testable without two real volumes.
 */
export function shouldUseRename(
  sourceDevice: number | null,
  destinationParentDevice: number | null,
  destinationExists: boolean,
): boolean {
  if (destinationExists) return false;
  if (sourceDevice === null || destinationParentDevice === null) return false;
  return sourceDevice === destinationParentDevice;
}

/** Every regular file under `dir`, keyed by path relative to it, valued by size. */
function fileSizes(
  dir: string,
  base: string = dir,
  out = new Map<string, number>(),
): Map<string, number> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) fileSizes(full, base, out);
    else if (entry.isFile()) out.set(relative(base, full), statSync(full).size);
  }
  return out;
}

/**
 * Confirm the copy landed before anything is done to the source.
 *
 * Paths and sizes, not hashes: hashing a large background gallery costs minutes, and the
 * failure that actually happens is a file that is missing or short, not one whose bits rotted
 * in the seconds since it was written.
 */
function verifyCopy(source: string, destination: string): void {
  const from = fileSizes(source);
  const to = fileSizes(destination);

  const problems: string[] = [];
  for (const [path, size] of from) {
    const copied = to.get(path);
    if (copied === undefined) problems.push(`${path} is missing`);
    else if (copied !== size) problems.push(`${path} is ${copied} bytes, expected ${size}`);
  }

  if (problems.length > 0) {
    const sample = problems.slice(0, 3).join('; ');
    throw new Error(
      `The copy is incomplete (${sample}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}). ` +
        'Nothing has been removed from the old folder.',
    );
  }
}

/**
 * Open the moved database and ask SQLite whether it survived.
 *
 * quick_check rather than integrity_check: it catches the realistic failure — a truncated or
 * partial file — in milliseconds, where a full check on a large database takes long enough to
 * read as a hang.
 */
function quickCheckDatabase(path: string): void {
  if (!existsSync(path)) return;

  let database: Database;
  try {
    // Read-only so the check itself cannot write, and so it creates no sidecars of its own
    // next to the file we just finished moving.
    database = new Database(path, { readonly: true });
  } catch (error) {
    throw new Error(`The moved chat database could not be opened: ${(error as Error).message}`);
  }

  try {
    const row = database.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get();
    const result = row?.quick_check ?? 'no result';
    if (result !== 'ok') {
      throw new Error(`The moved chat database failed its integrity check (${result}).`);
    }
  } finally {
    database.close();
  }
}

/**
 * Re-assert 0600 on the API keys, and report honestly when the volume cannot hold it.
 *
 * Copying does not reliably preserve mode across platforms, so this sets it unconditionally
 * rather than checking whether it survived. The read-back is the part that matters: on
 * exFAT and FAT — which is most external drives — chmod is a silent no-op and the file ends
 * up world-readable, and the user deserves to be told rather than reassured.
 */
function enforceSecretsMode(destination: string): string[] {
  const secrets = join(destination, 'secrets.json');
  if (process.platform === 'win32' || !existsSync(secrets)) return [];

  try {
    chmodSync(secrets, 0o600);
  } catch {
    // The read-back below is the real check; a failed chmod is only a hint.
  }

  const mode = statSync(secrets).mode & 0o777;
  if (mode === 0o600) return [];
  return [
    `This volume cannot store file permissions — secrets.json is mode ${mode.toString(8)} ` +
      'rather than 600, so your API keys are readable by other accounts on this machine.',
  ];
}

/** `data` -> `data.moved-20260803-164512`, so a moved-aside library is obvious in a file browser. */
function asideName(source: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${source}.moved-${stamp}`;
}

/**
 * Put the library at `destination`. The caller must have closed the database first.
 *
 * Nothing is removed from `source` here — that is `finish`'s job, and it runs only after the
 * caller has committed to the new location.
 */
export async function moveLibrary(
  source: string,
  destination: string,
  options: { forceCopy?: boolean } = {},
): Promise<TransferOutcome> {
  assertDatabaseReleased(source);

  const destinationExists = existsSync(destination);
  const useRename =
    !options.forceCopy &&
    shouldUseRename(deviceOf(source), deviceOf(dirname(destination)), destinationExists);

  if (useRename) {
    renameSync(source, destination);
    return {
      strategy: 'rename',
      warnings: enforceSecretsMode(destination),
      // Symmetric and reliable: the same syscall in the other direction.
      undo: () => {
        renameSync(destination, source);
      },
      // The source ceased to exist the moment the rename returned.
      finish: async () => null,
    };
  }

  try {
    await cp(source, destination, { recursive: true, preserveTimestamps: true, force: true });
    verifyCopy(source, destination);
    quickCheckDatabase(join(destination, 'chats.db'));
  } catch (error) {
    // Only clean up a directory we brought into existence. Deleting inside one the user
    // already had is not our call, so that partial copy is left for them to look at.
    if (!destinationExists) await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    strategy: 'copy',
    warnings: enforceSecretsMode(destination),
    undo: async () => {
      if (!destinationExists) await rm(destination, { recursive: true, force: true });
    },
    /*
     * Renamed aside, never deleted. This is the single most destructive thing the feature
     * could do, and an unauthenticated loopback request is not the right authority for
     * erasing someone's entire library — the same reasoning that makes deleted chats a
     * restorable trash bin rather than a delete.
     */
    finish: async () => {
      const aside = asideName(source);
      renameSync(source, aside);
      return aside;
    },
  };
}
