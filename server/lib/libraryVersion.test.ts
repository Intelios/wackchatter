import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema } from './db.ts';
import { libraryTooOld, MIN_SCHEMA_VERSION } from './libraryVersion.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-library-version-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function libraryAt(version: number | null): void {
  const database = new Database(join(dir, 'chats.db'), { create: true });
  database.exec(`
    CREATE TABLE chats (id TEXT PRIMARY KEY);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (version !== null) {
    database.query('INSERT INTO meta VALUES (?, ?)').run('schema_version', String(version));
  }
  database.close();
}

test('a library below 2.3 is too old, and 2.3 itself is not', () => {
  libraryAt(MIN_SCHEMA_VERSION - 1);
  expect(libraryTooOld(dir)).toBe(true);

  rmSync(join(dir, 'chats.db'));
  libraryAt(MIN_SCHEMA_VERSION);
  expect(libraryTooOld(dir)).toBe(false);
});

test('a chats table with no recorded version is too old', () => {
  libraryAt(null);
  expect(libraryTooOld(dir)).toBe(true);
});

test('no database, a fresh one, or an unreadable one is not reported as old', () => {
  expect(libraryTooOld(dir)).toBe(false);

  const fresh = new Database(join(dir, 'chats.db'), { create: true });
  createSchema(fresh);
  fresh.close();
  expect(libraryTooOld(dir)).toBe(false);

  rmSync(join(dir, 'chats.db'));
  writeFileSync(join(dir, 'chats.db'), 'x'.repeat(4096));
  expect(libraryTooOld(dir)).toBe(false);
});
