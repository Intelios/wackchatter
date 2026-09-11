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

/**
 * Bumped whenever the schema below grows. Exported because the migration tests assert that
 * an upgraded database is stamped with the CURRENT version — a literal in each test would
 * only pin that someone remembered to edit three files.
 */
export const SCHEMA_VERSION = 10;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id           TEXT    PRIMARY KEY,
  character_id TEXT,
  kind         TEXT    NOT NULL DEFAULT 'direct',
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

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  modified INTEGER NOT NULL,
  config TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nexus_embeddings (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  model TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY(chat_id, document_id, model)
) WITHOUT ROWID;

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
  finished_avatar TEXT,
  -- The card this session was seeded from (the Studio handoff), or NULL. Write-once at
  -- creation: the whole-session update statement never mentions it, so saves preserve it,
  -- and only the reference cascade (rename/delete) or row deletion ever changes it.
  seed_avatar     TEXT
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

-- Model Arena: one row per completed blind round.
--
-- Both sides live in one row rather than two, because a round is the unit of evidence:
-- half a comparison says nothing, and a schema that can store one is a schema that will.
-- Written once and never updated, so there is no revision column — an abandoned round is
-- never recorded at all.
--
-- Deliberately NOT derived into a ratings table. The leaderboard replays these rows in
-- order, which is what makes a rating impossible to drift from the rounds behind it and
-- lets the K-factor change without invalidating history. Same rule as Stats.
CREATE TABLE IF NOT EXISTS arena_rounds (
  id             TEXT    PRIMARY KEY,
  created        INTEGER NOT NULL,
  -- The card PNG filename. Not a foreign key: a deleted card must not take its rounds
  -- with it, the way a deleted character keeps its Stats history.
  character_id   TEXT    NOT NULL,
  probe          TEXT    NOT NULL,
  -- Contender pool ids resolve against settings for a name; the model and provider are
  -- facts about what actually ran and are what an unresolvable id falls back to.
  left_id        TEXT    NOT NULL,
  left_model     TEXT    NOT NULL,
  left_provider  TEXT    NOT NULL,
  left_text      TEXT    NOT NULL,
  right_id       TEXT    NOT NULL,
  right_model    TEXT    NOT NULL,
  right_provider TEXT    NOT NULL,
  right_text     TEXT    NOT NULL,
  -- left | right | tie | bad. Never null.
  verdict        TEXT    NOT NULL
);

-- Ascending, because chronological replay is the only read the leaderboard makes.
CREATE INDEX IF NOT EXISTS idx_arena_rounds_created ON arena_rounds(created ASC);

-- Model Arena tournaments: the bracket definition.
--
-- This row is the *plan*, and it is the one Arena thing that may be edited — a name and
-- an active/abandoned flag, that is all. Who advanced to a later stage is not stored:
-- it is derived by replaying arena_matches, the same way a rating is derived from the
-- rounds, so a bracket position cannot drift from the match that earned it. Completion
-- is derived too (the final has a match), which is why status has no 'completed'.
CREATE TABLE IF NOT EXISTS arena_tournaments (
  id       TEXT    PRIMARY KEY,
  created  INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  -- active | abandoned. Abandoning freezes the bracket; the matches already played stay
  -- on the career ladder, because evidence you can un-see was never evidence.
  status   TEXT    NOT NULL,
  -- 4 | 8 | 16. Powers of two only, so the bracket is balanced and no bye is invented.
  size     INTEGER NOT NULL,
  -- JSON arrays: the entrant ids in bracket-slot order, and the per-stage {characterId,
  -- cue} plan. Read defensively; a hand-edited row must not invent a stage or an entrant.
  entrants TEXT    NOT NULL,
  stages   TEXT    NOT NULL
);

-- One row per completed elimination match. Write-once, exactly like arena_rounds, and for
-- the same reason: a match is evidence, and evidence you can edit is not evidence.
--
-- verdict is only ever left or right. A dead heat is re-rolled once and then judged, so
-- tie/bad are consumed by that flow and never become advancement evidence; the rerolled
-- flag records that the match needed the second roll.
CREATE TABLE IF NOT EXISTS arena_matches (
  id             TEXT    PRIMARY KEY,
  tournament_id  TEXT    NOT NULL REFERENCES arena_tournaments(id) ON DELETE CASCADE,
  created        INTEGER NOT NULL,
  stage          INTEGER NOT NULL,
  match_index    INTEGER NOT NULL,
  -- Denormalised from the stage plan, like a round's character_id/cue: the plan can be
  -- edited away and a deleted card must not take its matches with it.
  character_id   TEXT    NOT NULL,
  cue            TEXT    NOT NULL,
  left_id        TEXT    NOT NULL,
  left_model     TEXT    NOT NULL,
  left_provider  TEXT    NOT NULL,
  left_text      TEXT    NOT NULL,
  right_id       TEXT    NOT NULL,
  right_model    TEXT    NOT NULL,
  right_provider TEXT    NOT NULL,
  right_text     TEXT    NOT NULL,
  verdict        TEXT    NOT NULL,
  rerolled       INTEGER NOT NULL DEFAULT 0
);

-- One match per bracket slot. The unique index is what makes a double-submit a rejected
-- write rather than a second match nobody can place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_arena_matches_slot
  ON arena_matches(tournament_id, stage, match_index);
`;

export function createSchema(database: Database): void {
  // CREATE TABLE IF NOT EXISTS deliberately does not evolve an existing table. Keep
  // migrations here, where fresh and upgraded databases take the same path.
  database.exec(SCHEMA);

  const chatColumns = database.query<{ name: string }, []>('PRAGMA table_info(chats)').all();
  if (!chatColumns.some((column) => column.name === 'revision')) {
    database.exec('ALTER TABLE chats ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }

  if (!chatColumns.some((column) => column.name === 'kind')) {
    // Rebuild only the parent, with FK enforcement off outside the transaction.
    // Child rows and their indexes remain untouched.
    database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.transaction(() => {
        database.exec(`CREATE TABLE chats_group_upgrade (
          id TEXT PRIMARY KEY, character_id TEXT, kind TEXT NOT NULL DEFAULT 'direct',
          title TEXT NOT NULL, created INTEGER NOT NULL, modified INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}');
          INSERT INTO chats_group_upgrade (id, character_id, title, created, modified, revision, metadata)
            SELECT id, character_id, title, created, modified, revision, metadata FROM chats;
          DROP TABLE chats;
          ALTER TABLE chats_group_upgrade RENAME TO chats;
          CREATE INDEX idx_chats_character ON chats(character_id, modified DESC);`);
      })();
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }

  // The persona a user message was sent as. NULL means "speaker not recorded" — rows
  // from before this column existed — while an empty string is the explicit "sent with
  // no persona", so the two states cannot collapse into one.
  const messageColumns = database.query<{ name: string }, []>('PRAGMA table_info(messages)').all();
  if (!messageColumns.some((column) => column.name === 'persona_id')) {
    database.exec('ALTER TABLE messages ADD COLUMN persona_id TEXT');
  }

  for (const name of ['member_id', 'character_id']) {
    if (!messageColumns.some((column) => column.name === name))
      database.exec(`ALTER TABLE messages ADD COLUMN ${name} TEXT`);
  }

  // The memory that hid a message. NULL covers both "hidden by a person" and every row
  // written before memories existed, which are the same thing as far as ownership goes:
  // no memory may reveal them.
  if (!messageColumns.some((column) => column.name === 'hidden_by')) {
    database.exec('ALTER TABLE messages ADD COLUMN hidden_by TEXT');
  }

  // The card a Co-Creator session was seeded from. NULL for every session that started
  // blank, which is all of them before the Studio handoff existed.
  const sessionColumns = database
    .query<{ name: string }, []>('PRAGMA table_info(cocreator_sessions)')
    .all();
  if (!sessionColumns.some((column) => column.name === 'seed_avatar')) {
    database.exec('ALTER TABLE cocreator_sessions ADD COLUMN seed_avatar TEXT');
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
