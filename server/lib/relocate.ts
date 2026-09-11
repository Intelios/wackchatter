/**
 * Moving the data directory while the server is running.
 *
 * Separate from location.ts because this is the layer that knows about the singletons —
 * database, chat store, settings cache — and db.ts already imports location.ts for its
 * cloud check. Keeping the orchestration here keeps that import one-way.
 *
 * The ordering rule the whole thing is built around:
 *
 *   The pointer write is the commit point. Before it, unwind. After it, never unwind —
 *   report the failure and ask for a restart, because a restart reads the pointer and lands
 *   in the right place. Rolling back after the commit is how you end up with a pointer and a
 *   library that disagree.
 *
 * Requests are gated while this runs. A concurrent switch hits the same gate, which makes
 * the operation single-flight without a lock of its own.
 */

import type { DataDirSource, LocationKind } from '../../shared/types/location.ts';
import { resetArenaStore } from './arena.ts';
import { resetChatStore } from './chats.ts';
import { resetCocreatorStore } from './cocreator.ts';
import { closeDatabase } from './db.ts';
import { drainLocks } from './fs.ts';
import { activeGenerations } from './generate.ts';
import { activeBackups } from './library.ts';
import { inspectLocation, resolveDataDir, writePointer } from './location.ts';
import { ensureDataDirs, PATHS, setDataDir } from './paths.ts';
import { ensureDefaultPreset } from './presets.ts';
import { resetSettingsCache } from './settings.ts';
import { moveLibrary, type TransferOutcome } from './transfer.ts';
import { publishLibraryPointer } from './usage.ts';

export interface SwitchResult {
  root: string;
  source: DataDirSource;
  strategy: 'rename' | 'copy' | 'adopt';
  warnings: string[];
  oldPathKept: string | null;
}

/** A failure the route can turn straight into a status code. */
export class RelocateError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RelocateError';
    this.status = status;
  }
}

let switching = false;
let degraded: string | null = null;

export function isSwitching(): boolean {
  return switching;
}

/**
 * Set when a move committed but the server could not reopen against the new folder. Every
 * API route refuses while this is set — a half-working app on a closed database would write
 * into the wrong place, and the pointer is already correct, so a restart fixes it.
 */
export function degradedReason(): string | null {
  return degraded;
}

/** Drop everything memoised from the old root, in the order their dependencies require. */
export function quiesce(): void {
  // Stores first: they hold prepared statements bound to the connection the next call closes.
  resetArenaStore();
  resetChatStore();
  resetCocreatorStore();
  closeDatabase();
  resetSettingsCache();
}

/**
 * Point the app at `input`, moving the library there if the folder is empty or adopting the
 * one already in it.
 *
 * `expect` is the classification the client was shown. Re-checking it here is the second
 * half of the two-click confirm: if someone dropped files into the folder between the
 * inspect and the commit, the user is told rather than surprised. It narrows the window
 * rather than closing it — there is no way to hold a directory still — but the window it
 * leaves is a human-scale one.
 */
export async function switchDataDir(input: string, expect: LocationKind): Promise<SwitchResult> {
  if (process.env.WC_DATA_DIR?.trim()) {
    throw new RelocateError(
      'The data folder is pinned by WC_DATA_DIR. Unset it and restart to change this here.',
      409,
    );
  }
  if (degraded) throw new RelocateError(degraded, 503);
  if (switching) throw new RelocateError('A folder move is already in progress.', 409);

  const verdict = inspectLocation(input);
  if (!verdict.ok) throw new RelocateError(verdict.message, 400);
  if (verdict.kind === 'same') {
    throw new RelocateError('That is already your data folder.', 409);
  }
  if (verdict.kind !== expect) {
    throw new RelocateError(
      `That folder is no longer ${expect === 'empty' ? 'empty' : 'a WackChatter library'}. ` +
        'Check it again before moving.',
      409,
    );
  }
  if (activeGenerations() > 0) {
    throw new RelocateError(
      'A reply is still streaming. Wait for it to finish, then try again.',
      409,
    );
  }
  // A backup reads the library a file at a time while it builds its archive, so moving it
  // underneath one truncates the result. Only that window is guarded — once the archive is
  // a finished file a move cannot hurt it. Refused before anything has been mutated.
  if (activeBackups() > 0) {
    throw new RelocateError(
      'A library backup is still being prepared. Wait for it to finish, then try again.',
      409,
    );
  }

  const source = PATHS.root;
  const destination = verdict.path;

  switching = true;
  try {
    // An atomicWrite in flight has its data in a temp sibling that has not been renamed into
    // place yet. Copying now would take the old file and strand the new one, so give up
    // rather than press on — making the user retry beats a torn copy of their library.
    if (!(await drainLocks(5000))) {
      throw new RelocateError(
        'WackChatter is still finishing a write to the current folder. Try again in a moment.',
        503,
      );
    }

    quiesce();

    // Adopting an existing library moves nothing, which is what makes it the cheapest and
    // safest path here: there is no physical change to undo.
    let transfer: TransferOutcome | null = null;
    if (verdict.kind === 'empty') {
      try {
        transfer = await moveLibrary(source, destination);
      } catch (error) {
        // Nothing has been committed and setDataDir has not run, so PATHS still names the
        // source and the singletons reopen against it on the next request.
        throw new RelocateError((error as Error).message, 500);
      }
    }

    try {
      await writePointer(destination);
    } catch (error) {
      try {
        await transfer?.undo();
      } catch {
        // The library is at the destination and the config still says the source. Say so
        // plainly below rather than pretend either half succeeded.
        throw new RelocateError(
          `Your library was moved to ${destination}, but the location could not be saved and ` +
            `moving it back also failed. Set WC_DATA_DIR=${destination} and restart to carry on.`,
          500,
        );
      }
      throw new RelocateError(
        `The new location could not be saved: ${(error as Error).message}`,
        500,
      );
    }

    // Committed. From here nothing unwinds.
    try {
      setDataDir(destination);
      ensureDataDirs();
      await ensureDefaultPreset();
      // The pointer names the old root until this runs; a reader following it would open
      // a library the app has stopped writing to.
      publishLibraryPointer();
    } catch (error) {
      degraded =
        `Your library moved to ${destination}, but the server could not open it there: ` +
        `${(error as Error).message}. Restart WackChatter to carry on — the new location is saved.`;
      throw new RelocateError(degraded, 500);
    }

    const warnings = [...(transfer?.warnings ?? [])];
    let oldPathKept: string | null = null;
    try {
      oldPathKept = (await transfer?.finish()) ?? null;
    } catch (error) {
      // The data is already safe at the destination, so a failure to tidy the source is a
      // note, not an error.
      warnings.push(
        `The old folder at ${source} could not be tidied up: ${(error as Error).message}. ` +
          'It is safe to remove by hand.',
      );
    }

    return {
      root: PATHS.root,
      source: resolveDataDir().source,
      strategy: transfer?.strategy ?? 'adopt',
      warnings,
      oldPathKept,
    };
  } finally {
    switching = false;
  }
}
