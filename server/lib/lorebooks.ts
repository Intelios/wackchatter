/**
 * Standalone lorebook storage. One JSON file per book in data/lorebooks.
 *
 * The filename stem is the id AND the name, exactly as SillyTavern does it — a character
 * card links to a book by name via `extensions.world`, so a book whose name and filename
 * could drift apart would break that link silently. Renaming is therefore a file move.
 *
 * The file format is ST's: `{ entries: { "<uid>": {...} } }`. Books drop straight into an
 * ST installation and back.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LorebookSummary, WorldInfoBook } from '../../shared/types/worldinfo.ts';
import { normalizeBook } from '../../shared/worldinfo/convert.ts';
import { withFileLock, withFileLocks, withResourceLock } from './fs.ts';
import { PATHS, safeJoin, sanitizeFilename, uniqueName } from './paths.ts';

function bookPath(id: string): string | null {
  return safeJoin(PATHS.lorebooks, `${id}.json`);
}

function bookExists(name: string): boolean {
  return existsSync(join(PATHS.lorebooks, `${name}.json`));
}

type Rollback = () => Promise<void> | void;
const LOREBOOK_IDENTITIES = 'lorebook-identities';

function serializeLorebook(id: string, book: WorldInfoBook): string {
  const { originalData: _drop, ...rest } = book;
  return `${JSON.stringify({ ...rest, name: id }, null, 4)}\n`;
}

export function listLorebooks(): LorebookSummary[] {
  if (!existsSync(PATHS.lorebooks)) return [];

  return readdirSync(PATHS.lorebooks)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => {
      const id = basename(file, '.json');
      let entryCount = 0;
      try {
        const parsed = JSON.parse(readFileSync(join(PATHS.lorebooks, file), 'utf8')) as unknown;
        const entries = (parsed as { entries?: unknown })?.entries;
        if (Array.isArray(entries)) entryCount = entries.length;
        else if (entries && typeof entries === 'object') entryCount = Object.keys(entries).length;
      } catch {
        // A corrupt book still appears in the list, with a count of zero. Hiding it would
        // leave the user with a file they cannot see, let alone fix.
      }

      return {
        id,
        name: id,
        entryCount,
        modified: statSync(join(PATHS.lorebooks, file)).mtimeMs,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getLorebook(id: string): WorldInfoBook | null {
  const path = bookPath(id);
  if (!path || !existsSync(path)) return null;

  try {
    return normalizeBook(JSON.parse(readFileSync(path, 'utf8')), id);
  } catch (error) {
    throw new Error(`Lorebook "${id}" could not be read: ${(error as Error).message}`);
  }
}

export async function saveLorebook(id: string, book: WorldInfoBook): Promise<boolean> {
  return writeLorebook(id, book, false);
}

async function writeLorebook(
  id: string,
  book: WorldInfoBook,
  allowCreate: boolean,
): Promise<boolean> {
  const path = bookPath(id);
  if (!path) throw new Error(`"${id}" is not a usable lorebook name.`);

  // The name always tracks the filename; see the header. `originalData` is dropped —
  // it only exists to round-trip an embedded book back into a card.
  return withFileLock(path, async (replace) => {
    // A stale PUT that waited behind a rename/delete must not recreate the old identity.
    if (!allowCreate && !existsSync(path)) return false;
    await replace(serializeLorebook(id, book));
    return true;
  });
}

export async function deleteLorebook(id: string, onStaged?: () => Promise<void>): Promise<boolean> {
  const path = bookPath(id);
  if (!path) return false;

  return withResourceLock(LOREBOOK_IDENTITIES, () =>
    withFileLock(path, async () => {
      if (!existsSync(path)) return false;
      const tombstone = `${path}.${crypto.randomUUID()}.deleting`;
      await rename(path, tombstone);
      try {
        await onStaged?.();
      } catch (error) {
        await rename(tombstone, path).catch((rollbackError) => {
          throw new AggregateError([error, rollbackError], 'Lorebook delete rollback failed.');
        });
        throw error;
      }

      await unlink(tombstone).catch((error) => {
        console.error(`[wackchatter] Could not remove lorebook tombstone: ${String(error)}`);
      });
      return true;
    }),
  );
}

/** Rename by moving the file, since the filename is the identity. */
export async function renameLorebook(
  id: string,
  nextName: string,
  onStaged?: (newId: string) => Promise<Rollback | undefined>,
): Promise<LorebookSummary | null> {
  return withResourceLock(LOREBOOK_IDENTITIES, async () => {
    const from = bookPath(id);
    if (!from) return null;

    const base = sanitizeFilename(nextName);
    if (!base) throw new Error(`"${nextName}" is not a usable lorebook name.`);
    if (base === id) {
      return listLorebooks().find((summary) => summary.id === id) ?? null;
    }
    if (bookExists(base)) throw new Error(`A lorebook called "${base}" already exists.`);

    const to = bookPath(base);
    if (!to) throw new Error(`"${nextName}" is not a usable lorebook name.`);

    return withFileLocks([from, to], async (replace) => {
      if (!existsSync(from)) return null;
      const book = normalizeBook(JSON.parse(readFileSync(from, 'utf8')) as unknown, id);
      await replace(to, serializeLorebook(base, book));

      let rollback: Rollback | undefined;
      try {
        rollback = await onStaged?.(base);
        await unlink(from);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (rollback) {
          try {
            await rollback();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        try {
          await unlink(to);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], 'Lorebook rename rollback failed.');
        }
        throw error;
      }

      return listLorebooks().find((summary) => summary.id === base) ?? null;
    });
  });
}

/** Create a book under a free name derived from `suggestedName`. */
export async function createLorebook(
  suggestedName: string,
  book?: WorldInfoBook,
): Promise<LorebookSummary> {
  return withResourceLock(LOREBOOK_IDENTITIES, async () => {
    const base = sanitizeFilename(suggestedName.replace(/\.json$/i, '')) ?? 'New Lorebook';
    const id = uniqueName(base, bookExists);

    await writeLorebook(id, book ? normalizeBook(book, id) : { name: id, entries: {} }, true);
    return (
      listLorebooks().find((summary) => summary.id === id) ?? {
        id,
        name: id,
        entryCount: 0,
        modified: Date.now(),
      }
    );
  });
}
