/**
 * Which libraries this build opens.
 *
 * 3.0 carries no migrations for libraries older than 2.3: everything 1.x and 2.x changed was
 * rewritten by 2.3 the first time it opened the library, and `chats.db` records that as
 * schema version 14. Anything below it is refused rather than half-read.
 *
 * A module of its own because both db.ts and location.ts need it, and db.ts already imports
 * location.ts — a check living in either would make that import a cycle.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The schema WackChatter 2.3 wrote. */
export const MIN_SCHEMA_VERSION = 14;

export const LIBRARY_TOO_OLD_MESSAGE =
  'This library was last opened by a WackChatter older than 2.3. Open it once in ' +
  'WackChatter 2.3 to bring it up to date, then open it here.';

export class LibraryTooOldError extends Error {
  constructor() {
    super(LIBRARY_TOO_OLD_MESSAGE);
    this.name = 'LibraryTooOldError';
  }
}

/**
 * The schema version a database records: null for a fresh one with no chats table yet, 0
 * for a chats table with no recorded version (a build from before versions were stamped).
 */
export function schemaVersionOf(database: Database): number | null {
  const tables = new Set(
    database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('chats', 'meta')",
      )
      .all()
      .map((row) => row.name),
  );
  if (!tables.has('chats')) return null;
  if (!tables.has('meta')) return 0;
  const row = database
    .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
    .get('schema_version');
  const version = Number(row?.value);
  return Number.isFinite(version) ? version : 0;
}

/**
 * Whether the library in `dir` predates 2.3. Read-only. A missing database is not old, and
 * neither is an unreadable one: that failure belongs to the open that follows, which
 * already reports it, rather than to a check that would misname it.
 */
export function libraryTooOld(dir: string): boolean {
  const path = join(dir, 'chats.db');
  if (!existsSync(path)) return false;
  let database: Database | null = null;
  try {
    database = new Database(path, { readonly: true });
    const version = schemaVersionOf(database);
    return version !== null && version < MIN_SCHEMA_VERSION;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
