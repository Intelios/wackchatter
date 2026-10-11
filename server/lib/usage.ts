/** Retained, local generation ledger and library discovery. Failures never interrupt
 * generation. TokenTrail reads these files but never writes to this library.
 * See docs/tokentrail-integration.md for the versioned cross-app contract. */

import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LIBRARY_POINTER_NAME,
  USAGE_DIR_NAME,
  type UsageRecord,
} from '../../shared/types/usage.ts';
import { PATHS } from './paths.ts';

/** `home` is injected so tests never touch the real home directory. */
export function usageDir(home: string = homedir()): string {
  return join(home, USAGE_DIR_NAME);
}

const writerId = crypto.randomUUID();
export function usageLogPath(home?: string, now = new Date()): string {
  return join(usageDir(home), 'usage', 'v2', now.toISOString().slice(0, 7), `${writerId}.jsonl`);
}

export function libraryIdentity(): string {
  try { const marker = JSON.parse(readFileSync(join(PATHS.root, '.wackchatter'), 'utf8'));
    if (typeof marker.created === 'string') return marker.created;
  } catch { /* legacy library */ }
  return PATHS.root;
}

let runtimeAddresses: { apiUrl: string; frontendUrl: string } | null = null;
export function runtimeDescriptor() {
  return { version: 1, libraryId: libraryIdentity(), ...(runtimeAddresses ?? {}) };
}
export function configureRuntime(apiUrl: string, frontendUrl: string, home?: string): void {
  runtimeAddresses = { apiUrl, frontendUrl };
  publishRuntime(home);
}
export function publishRuntime(home?: string): void {
  if (process.env.WC_DATA_DIR?.trim() || !runtimeAddresses) return;
  try { mkdirSync(usageDir(home), { recursive: true, mode: 0o700 });
    const target = join(usageDir(home), 'runtime.json');
    const temporary = `${target}.${writerId}.tmp`;
    writeFileSync(temporary, JSON.stringify(runtimeDescriptor()) + '\n', { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) { warnOnce(error); }
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

/** Append one record. Returns false when it could not be written. */
export function appendUsage(record: UsageRecord, home?: string): boolean {
  try {
    const path = usageLogPath(home);
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
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
 *
 * One exception: a WC_DATA_DIR boot says nothing. The env var is an override for this
 * process — a test, or an agent working against a scratch copy of the library — not the
 * user's chosen home for it, so publishing PATHS.root here would repoint readers at a
 * throwaway copy (observed: a scratch boot replaced the real library path in this file).
 * Leave it alone; the next ordinary boot republishes and heals it.
 */
export function publishLibraryPointer(home?: string): void {
  // Same test resolveDataDir uses to classify a boot as source 'env'. An empty or blank
  // value counts as unset there, so it must here too.
  if (process.env.WC_DATA_DIR?.trim()) return;
  try {
    const dir = usageDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    publishRuntime(home);
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
