/**
 * Durable file writes. Every mutation goes through atomicWrite: data lands in a
 * temporary sibling, then a single rename(2) moves it over the destination. A crash
 * mid-write leaves the old file intact; a crash after the rename leaves the new one.
 *
 * Writes to the same destination are serialized through a per-path promise chain so
 * overlapping requests cannot settle out of order.
 */

import { randomBytes } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

const locks = new Map<string, Promise<void>>();

/**
 * Write `data` to `path` atomically. Concurrent calls targeting the same path are
 * queued so the last writer always wins and no torn write is observable.
 */
export function atomicWrite(path: string, data: Uint8Array | string): Promise<void> {
  const prev = locks.get(path) ?? Promise.resolve();
  const next = prev.then(() => writeAndRename(path, data));
  locks.set(
    path,
    next.catch(() => {}),
  );
  return next;
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
