/**
 * The usage log.
 *
 * One JSONL line per generation in `~/.wackchatter/`, beside a pointer to wherever the
 * library currently is. Both live in the home directory rather than in the library for
 * the same reason the location pointer does (see location.ts): a reader outside this app
 * has to be able to find them without already knowing where the data folder went.
 *
 * Appends are plain `appendFileSync`, not the atomic write used elsewhere. Atomic write
 * is whole-file — it would rewrite megabytes per generation, and two generations settling
 * together would lose one. An append of a single line under 4 KB does not interleave.
 *
 * Nothing here may throw at a caller. A usage log that breaks a generation is worse than
 * no usage log, so every failure is swallowed after one warning.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LIBRARY_POINTER_NAME,
  USAGE_DIR_NAME,
  USAGE_LOG_MAX_BYTES,
  USAGE_LOG_NAME,
  type UsageRecord,
} from '../../shared/types/usage.ts';
import { PATHS } from './paths.ts';

/** `home` is injected so tests never touch the real home directory. */
export function usageDir(home: string = homedir()): string {
  return join(home, USAGE_DIR_NAME);
}

export function usageLogPath(home?: string): string {
  return join(usageDir(home), USAGE_LOG_NAME);
}

export function libraryPointerPath(home?: string): string {
  return join(usageDir(home), LIBRARY_POINTER_NAME);
}

let warned = false;

function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  // The message, not the error: this is a warning about an optional file, and a stack
  // trace in the console reads like something broke.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[wackchatter] usage log unavailable — continuing without it: ${message}`);
}

/**
 * Rotate at the size cap, keeping exactly one generation back.
 *
 * The reader tails `usage.jsonl` alone, so a rotated file is invisible to it. That is
 * deliberate: records are idempotent on `id`, so the only thing a rotation can cost is
 * events that were never read, and the reader's own database backfill covers those.
 */
function rotateIfLarge(path: string): void {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size < USAGE_LOG_MAX_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch (error) {
    warnOnce(error);
  }
}

/** Append one record. Returns false when it could not be written. */
export function appendUsage(record: UsageRecord, home?: string): boolean {
  try {
    const dir = usageDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, USAGE_LOG_NAME);
    rotateIfLarge(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (error) {
    warnOnce(error);
    return false;
  }
}

export interface LibraryPointer {
  version: 1;
  dataDir: string;
  updated: string;
}

/**
 * Publish where the library is, so a reader can open chats.db for history rather than
 * only seeing generations that happened while it was watching.
 *
 * Rewritten on every boot and after a relocation, and unconditionally — this file says
 * where the data is, not whether logging is on. Turning the log off should stop new
 * records, not strand a reader that already has years of history to account for.
 */
export function publishLibraryPointer(home?: string): void {
  try {
    const dir = usageDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const pointer: LibraryPointer = {
      version: 1,
      dataDir: PATHS.root,
      updated: new Date().toISOString(),
    };
    writeFileSync(join(dir, LIBRARY_POINTER_NAME), `${JSON.stringify(pointer, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (error) {
    warnOnce(error);
  }
}
