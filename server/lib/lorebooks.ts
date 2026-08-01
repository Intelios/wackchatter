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

import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { LorebookSummary, WorldInfoBook } from '../../shared/types/worldinfo.ts';
import { normalizeBook } from '../../shared/worldinfo/convert.ts';
import { PATHS, safeJoin, sanitizeFilename, uniqueName } from './paths.ts';

function bookPath(id: string): string | null {
  return safeJoin(PATHS.lorebooks, `${id}.json`);
}

function bookExists(name: string): boolean {
  return existsSync(join(PATHS.lorebooks, `${name}.json`));
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

export async function saveLorebook(id: string, book: WorldInfoBook): Promise<void> {
  const path = bookPath(id);
  if (!path) throw new Error(`"${id}" is not a usable lorebook name.`);

  // The name always tracks the filename; see the header. `originalData` is dropped —
  // it only exists to round-trip an embedded book back into a card.
  const { originalData: _drop, ...rest } = book;
  await Bun.write(path, `${JSON.stringify({ ...rest, name: id }, null, 4)}\n`);
}

export function deleteLorebook(id: string): boolean {
  const path = bookPath(id);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Rename by moving the file, since the filename is the identity. */
export function renameLorebook(id: string, nextName: string): LorebookSummary | null {
  const from = bookPath(id);
  if (!from || !existsSync(from)) return null;

  const base = sanitizeFilename(nextName);
  if (!base) throw new Error(`"${nextName}" is not a usable lorebook name.`);
  if (base === id) return { id, name: id, entryCount: 0, modified: statSync(from).mtimeMs };
  if (bookExists(base)) throw new Error(`A lorebook called "${base}" already exists.`);

  const to = bookPath(base);
  if (!to) throw new Error(`"${nextName}" is not a usable lorebook name.`);
  renameSync(from, to);

  // The stored `name` has to follow the file or the two would disagree on next read.
  const book = getLorebook(base);
  if (book) void saveLorebook(base, book);

  return listLorebooks().find((summary) => summary.id === base) ?? null;
}

/** Create a book under a free name derived from `suggestedName`. */
export async function createLorebook(
  suggestedName: string,
  book?: WorldInfoBook,
): Promise<LorebookSummary> {
  const base = sanitizeFilename(suggestedName.replace(/\.json$/i, '')) ?? 'New Lorebook';
  const id = uniqueName(base, bookExists);

  await saveLorebook(id, book ? normalizeBook(book, id) : { name: id, entries: {} });
  return (
    listLorebooks().find((summary) => summary.id === id) ?? {
      id,
      name: id,
      entryCount: 0,
      modified: Date.now(),
    }
  );
}
