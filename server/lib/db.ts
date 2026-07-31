/**
 * SQLite connection and schema.
 *
 * Chats are ours and deliberately not portable, so unlike cards and presets there is no
 * external format to honour — only the shape that makes the message model cheap to query.
 */

import { Database } from 'bun:sqlite';
import { PATHS } from './paths.ts';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id           TEXT    PRIMARY KEY,
  character_id TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  created      INTEGER NOT NULL,
  modified     INTEGER NOT NULL,
  metadata     TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_chats_character ON chats(character_id, modified DESC);

-- One row per message. Swipes stay a JSON column rather than their own table: nothing
-- ever queries across swipes, and keeping them in the row means the array and the index
-- that selects from it update together in a single write.
CREATE TABLE IF NOT EXISTS messages (
  chat_id    TEXT    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  id         TEXT    NOT NULL,
  position   INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  is_user    INTEGER NOT NULL,
  is_system  INTEGER NOT NULL,
  swipe_id   INTEGER NOT NULL DEFAULT 0,
  swipes     TEXT    NOT NULL,
  swipe_info TEXT    NOT NULL,
  PRIMARY KEY (chat_id, id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_order ON messages(chat_id, position);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function createSchema(database: Database): void {
  database.exec(SCHEMA);
  database
    .query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION));
}

export function openDatabase(path: string): Database {
  const database = new Database(path, { create: true });

  // foreign_keys is a per-CONNECTION setting, not a property of the file. Without it
  // here, ON DELETE CASCADE silently does nothing and orphaned message rows accumulate
  // invisibly.
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');

  createSchema(database);
  return database;
}

let instance: Database | null = null;

/** The application database, opened on first use. */
export function getDb(): Database {
  instance ??= openDatabase(PATHS.db);
  return instance;
}
