/**
 * SQLite connection and schema.
 *
 * Chats are ours and deliberately not portable, so unlike cards and presets there is no
 * external format to honour — only the shape that makes the message model cheap to query.
 */

import { Database } from 'bun:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { detectCloudProvider } from './location.ts';
import { PATHS } from './paths.ts';

const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id           TEXT    PRIMARY KEY,
  character_id TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  created      INTEGER NOT NULL,
  modified     INTEGER NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 0,
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
  -- Which memory hid this message, or NULL when a person did. Only meaningful alongside
  -- is_system; it is what lets deleting a memory reveal its own messages without also
  -- undoing an overlapping manual /hide.
  hidden_by  TEXT,
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

-- Character Co-Creator: a design conversation and the card fields stashed out of it.
-- Deliberately NOT the chats table: a session has no character, is never backed up on
-- delete, and must not appear in the recent-chats list or the per-character picker.
CREATE TABLE IF NOT EXISTS cocreator_sessions (
  id              TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  created         INTEGER NOT NULL,
  modified        INTEGER NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 0,
  -- CardStash: a partial CardDataV2 plus per-slot provenance. See shared/cocreator/stash.ts.
  stash           TEXT    NOT NULL DEFAULT '{"alternate_greetings":[],"tags":[]}',
  -- {cards: string[] (avatar filenames), fields: Record<ExampleField, boolean>}
  examples        TEXT    NOT NULL DEFAULT '{"cards":[],"fields":{}}',
  -- Per-session overrides of AppSettings.coCreator. A missing key follows the app setting.
  settings        TEXT    NOT NULL DEFAULT '{}',
  -- Filename under data/cocreator/avatars, or NULL. Bytes never live in this database.
  avatar          TEXT,
  -- The card this session produced, once Finish has run. Kept rather than deleting the
  -- session: the transcript is the reasoning behind the card and is worth going back to.
  finished_avatar TEXT
);

CREATE INDEX IF NOT EXISTS idx_cocreator_sessions_modified
  ON cocreator_sessions(modified DESC);

-- One row per turn, shaped like the messages table so shared/chat/message.ts serves both.
-- No name column: a design session has exactly two speakers, so the label is UI text
-- rather than data worth storing per row.
CREATE TABLE IF NOT EXISTS cocreator_messages (
  session_id TEXT    NOT NULL REFERENCES cocreator_sessions(id) ON DELETE CASCADE,
  id         TEXT    NOT NULL,
  position   INTEGER NOT NULL,
  is_user    INTEGER NOT NULL,
  swipe_id   INTEGER NOT NULL DEFAULT 0,
  swipes     TEXT    NOT NULL,
  swipe_info TEXT    NOT NULL,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cocreator_messages_order
  ON cocreator_messages(session_id, position);
`;

export function createSchema(database: Database): void {
  // CREATE TABLE IF NOT EXISTS deliberately does not evolve an existing table. Keep
  // migrations here, where fresh and upgraded databases take the same path.
  database.exec(SCHEMA);

  const chatColumns = database.query<{ name: string }, []>('PRAGMA table_info(chats)').all();
  if (!chatColumns.some((column) => column.name === 'revision')) {
    database.exec('ALTER TABLE chats ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }

  // The persona a user message was sent as. NULL means "speaker not recorded" — rows
  // from before this column existed — while an empty string is the explicit "sent with
  // no persona", so the two states cannot collapse into one.
  const messageColumns = database.query<{ name: string }, []>('PRAGMA table_info(messages)').all();
  if (!messageColumns.some((column) => column.name === 'persona_id')) {
    database.exec('ALTER TABLE messages ADD COLUMN persona_id TEXT');
  }

  // The memory that hid a message. NULL covers both "hidden by a person" and every row
  // written before memories existed, which are the same thing as far as ownership goes:
  // no memory may reveal them.
  if (!messageColumns.some((column) => column.name === 'hidden_by')) {
    database.exec('ALTER TABLE messages ADD COLUMN hidden_by TEXT');
  }

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

  /*
   * WAL is faster, but it spreads the database across chats.db, -wal and -shm — and the one
   * thing every sync client gets wrong is treating three interdependent files as three
   * independent ones, uploading them at different moments. In a synced folder that is
   * corruption waiting to happen, so trade write throughput for a single self-contained
   * file. journal_mode is persisted in the file header, so a library moved back off a synced
   * folder picks WAL up again on the next open.
   */
  const synced = detectCloudProvider(path) !== null;
  database.exec(`PRAGMA journal_mode = ${synced ? 'DELETE' : 'WAL'}`);
  database.exec('PRAGMA synchronous = NORMAL');

  createSchema(database);
  return database;
}

let instance: Database | null = null;
/** Where `instance` was opened. Remembered so a close still finds it after PATHS moves. */
let instancePath: string | null = null;

/** The application database, opened on first use. */
export function getDb(): Database {
  if (!instance) {
    instancePath = PATHS.db;
    instance = openDatabase(instancePath);
  }
  return instance;
}

/** Fold the write-ahead log into the main file and switch it off, leaving one file. */
function settle(database: Database): void {
  // TRUNCATE rather than PASSIVE (which can leave frames behind) or FULL (which does not
  // shrink the log). This is the step that matters: in WAL mode most of the database can be
  // sitting in chats.db-wal, so moving chats.db alone without it loses nearly everything.
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // Bun caches prepared statements, so close() does not release the connection the way a
  // plain sqlite3_close would, and SQLite never gets round to deleting the sidecars itself.
  // Leaving WAL removes chats.db-wal explicitly — the one that carries data.
  database.exec('PRAGMA journal_mode = DELETE');
}

/**
 * Put the database at rest so its file can be moved as a single self-contained unit.
 *
 * Handles the case where nothing has opened it in this process but a previous run left a log
 * behind: that log holds real data, so it is folded in rather than treated as an obstacle.
 */
export function closeDatabase(): void {
  const path = instancePath ?? PATHS.db;
  let settled = false;

  if (instance) {
    try {
      settle(instance);
      settled = true;
    } catch {
      // Releasing the handle still matters more than settling cleanly. The sidecars stay
      // where they are, and the caller refuses to move a database that still has them.
    }
    instance.close();
    instance = null;
    instancePath = null;
  } else if (existsSync(`${path}-wal`)) {
    /*
     * A log left by a run that did not shut down cleanly, or by another process holding the
     * database right now. Folding it in is worth attempting, because the data in it is real —
     * but failing is not worth throwing over: nothing is moved until the caller has checked
     * that the sidecars are gone.
     */
    try {
      const recovered = new Database(path, { readwrite: true });
      try {
        settle(recovered);
        settled = true;
      } finally {
        recovered.close();
      }
    } catch {
      return;
    }
  } else {
    settled = true;
  }

  /*
   * Only once settle succeeded. chats.db-wal holds real data until it has been checkpointed,
   * so deleting it on the failure path would be the exact data loss this function exists to
   * prevent. -shm is pure scratch and is rebuilt on demand.
   */
  if (!settled) return;

  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // Already gone, which is the expected case.
    }
  }
}
