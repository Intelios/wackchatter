/**
 * Durable file writes. Every mutation goes through atomicWrite: data lands in a
 * temporary sibling, then a single rename(2) moves it over the destination. A crash
 * mid-write leaves the old file intact; a crash after the rename leaves the new one.
 *
 * Writes to the same destination are serialized through a per-path promise chain so
 * overlapping requests cannot settle out of order.
 */

import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';

const locks = new Map<string, Promise<void>>();

type AtomicReplace = (data: Uint8Array | string) => Promise<void>;
type AtomicReplaceAt = (path: string, data: Uint8Array | string) => Promise<void>;

async function withLock<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const reservation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => reservation);
  locks.set(key, tail);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Serialize a non-file resource such as a directory's filename allocation. */
export function withResourceLock<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  return withLock(`resource:${key}`, task);
}

/**
 * Wait for every in-flight locked operation to settle.
 *
 * Used before the data directory moves. An atomicWrite in flight has its data in a
 * temporary sibling that has not been renamed into place yet, so copying the tree at that
 * moment captures the old file and strands the new one. Returns false on timeout, and the
 * caller is expected to abandon rather than press on: making the user retry is a far better
 * outcome than a torn copy of their library.
 */
export async function drainLocks(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Locks released while we wait can be replaced by new ones, so re-check rather than
  // awaiting a single snapshot of the map.
  while (locks.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...locks.values()]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, remaining);
      }),
    ]);
    clearTimeout(timer);
  }
  return true;
}

/**
 * Lock one file for a complete read/modify/write operation.
 *
 * The supplied replacement function writes without reacquiring the same lock. Calling
 * `atomicWrite(path, ...)` from inside `task` would deadlock; use `replace(...)` instead.
 */
export function withFileLock<T>(
  path: string,
  task: (replace: AtomicReplace) => Promise<T> | T,
): Promise<T> {
  return withFileLocks([path], (replaceAt) => task((data) => replaceAt(path, data)));
}

/** Lock several files in a stable order, for a rename or other cross-file operation. */
export function withFileLocks<T>(
  paths: string[],
  task: (replace: AtomicReplaceAt) => Promise<T> | T,
): Promise<T> {
  const unique = [...new Set(paths)].sort();
  const allowed = new Set(unique);

  const acquire = (index: number): Promise<T> => {
    const path = unique[index];
    if (!path) {
      return Promise.resolve(
        task((target, data) => {
          if (!allowed.has(target)) {
            return Promise.reject(new Error(`File "${target}" is not held by this operation.`));
          }
          return writeAndRename(target, data);
        }),
      );
    }
    return withLock(`file:${path}`, () => acquire(index + 1));
  };

  return acquire(0);
}

/**
 * Write `data` to `path` atomically. Concurrent calls targeting the same path are
 * queued so the last writer always wins and no torn write is observable.
 */
export function atomicWrite(path: string, data: Uint8Array | string): Promise<void> {
  return withFileLock(path, (replace) => replace(data));
}

/** Synchronous atomic replacement for synchronous stores such as cached app settings. */
export function atomicWriteSync(path: string, data: Uint8Array | string): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The original failure is the useful one. A missing temp file needs no cleanup.
    }
    throw error;
  }
}

async function writeAndRename(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
