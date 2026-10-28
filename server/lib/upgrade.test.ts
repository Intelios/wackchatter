import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from './chats.ts';
import { createSchema } from './db.ts';
import { DEFAULT_DATA_DIR, PATHS, setDataDir } from './paths.ts';
import { upgradeLibrary } from './upgrade.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-upgrade-'));
  setDataDir(dir);
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
  // paths.ts is shared across the whole test process; put it back.
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
});

function settings(value: Record<string, unknown>): void {
  writeFileSync(PATHS.settings, `${JSON.stringify(value, null, 2)}\n`);
}

/** A chat row exactly as 2.3 may have left it, written past the store's own normalising. */
function storedChat(id: string, metadata: string, modified = 100): void {
  db.query(
    `INSERT INTO chats (id, character_id, title, created, modified, revision, metadata)
     VALUES (?, 'a.png', ?, 1, ?, 3, ?)`,
  ).run(id, id, modified, metadata);
}

function storedUserMessage(chatId: string, id: string, position: number, personaId: string | null) {
  db.query(
    `INSERT INTO messages (chat_id, id, position, name, is_user, is_system, persona_id, swipe_id, swipes, swipe_info)
     VALUES (?, ?, ?, 'Jack', 1, 0, ?, 0, '["hi"]', '[{"send_date":""}]')`,
  ).run(chatId, id, position, personaId);
}

function row(id: string) {
  return db
    .query<{ metadata: string; modified: number; revision: number }, [string]>(
      'SELECT metadata, modified, revision FROM chats WHERE id = ?',
    )
    .get(id)!;
}

test('the pre-Nexus memories mode becomes nexus, in settings.json and in every chat', () => {
  settings({ memoryMode: 'memories', personaId: 'ari', streamingFps: 30 });
  storedChat('old-mode', JSON.stringify({ memoryMode: 'memories', persona: 'ari' }));
  storedChat('unfrozen', JSON.stringify({ persona: 'ari' }));
  storedChat('kept', JSON.stringify({ memoryMode: 'off', persona: 'ari' }));

  expect(upgradeLibrary(db)).toBe(true);

  expect(JSON.parse(row('old-mode').metadata).memoryMode).toBe('nexus');
  // A chat 2.0 never froze follows the default, read from the converted setting.
  expect(JSON.parse(row('unfrozen').metadata).memoryMode).toBe('nexus');
  expect(JSON.parse(row('kept').metadata).memoryMode).toBe('off');
  const written = JSON.parse(readFileSync(PATHS.settings, 'utf8'));
  expect(written).toEqual({ memoryMode: 'nexus', personaId: 'ari', streamingFps: 30 });
});

test('a chat with no recorded persona gets the current one, and an explicit none is kept', () => {
  settings({ memoryMode: 'classic', personaId: 'ari' });
  storedChat('unrecorded', JSON.stringify({ memoryMode: 'classic' }));
  storedChat('none', JSON.stringify({ memoryMode: 'classic', persona: null }));

  upgradeLibrary(db);

  expect(JSON.parse(row('unrecorded').metadata).persona).toBe('ari');
  expect(JSON.parse(row('none').metadata)).toHaveProperty('persona', null);
});

test('unrecorded user messages take the chat persona; recorded ones and replies do not move', () => {
  settings({ memoryMode: 'classic', personaId: null });
  storedChat('c', JSON.stringify({ memoryMode: 'classic', persona: 'ari' }));
  storedChat('n', JSON.stringify({ memoryMode: 'classic', persona: null }));
  storedUserMessage('c', 'unrecorded', 0, null);
  storedUserMessage('c', 'recorded', 1, 'old-face');
  storedUserMessage('n', 'no-persona', 0, null);
  db.query(
    `INSERT INTO messages (chat_id, id, position, name, is_user, is_system, swipe_id, swipes, swipe_info)
     VALUES ('c', 'reply', 2, 'Seraphina', 0, 0, 0, '["hello"]', '[{"send_date":""}]')`,
  ).run();

  upgradeLibrary(db);

  const persona = (id: string) =>
    db
      .query<{ persona_id: string | null }, [string]>(
        'SELECT persona_id FROM messages WHERE id = ?',
      )
      .get(id)!.persona_id;
  expect(persona('unrecorded')).toBe('ari');
  expect(persona('recorded')).toBe('old-face');
  // The column's empty string is the explicit "sent with no persona".
  expect(persona('no-persona')).toBe('');
  expect(persona('reply')).toBeNull();

  const store = createChatStore(db, { backupDir: null });
  expect(store.getChat('n')?.messages[0]?.persona_id).toBeNull();
});

test('recency is untouched, the revision moves, and a second run changes nothing', () => {
  settings({ memoryMode: 'nexus', personaId: 'ari' });
  storedChat('aged', JSON.stringify({}), 42);
  storedChat('converted', JSON.stringify({ memoryMode: 'nexus', persona: 'ari' }), 7);

  expect(upgradeLibrary(db)).toBe(false);
  const after = row('aged');
  expect(after.modified).toBe(42);
  expect(after.revision).toBeGreaterThan(3);
  // Nothing to convert, nothing written.
  expect(row('converted').revision).toBe(3);

  db.query("UPDATE chats SET metadata = '{}' WHERE id = 'aged'").run();
  upgradeLibrary(db);
  expect(row('aged').metadata).toBe('{}');
});

test('malformed metadata converts as an empty object rather than vanishing', () => {
  settings({ memoryMode: 'classic', personaId: 'ari' });
  storedChat('null-meta', 'null');

  upgradeLibrary(db);

  expect(JSON.parse(row('null-meta').metadata)).toEqual({ memoryMode: 'classic', persona: 'ari' });
});

test('a library with no settings file converts against the defaults', () => {
  storedChat('c', JSON.stringify({}));

  expect(upgradeLibrary(db)).toBe(false);

  expect(JSON.parse(row('c').metadata)).toEqual({ memoryMode: 'classic', persona: null });
});

test('a group scene left by 2.x is not converted', () => {
  settings({ memoryMode: 'memories', personaId: 'ari' });
  db.query(
    `INSERT INTO chats (id, character_id, kind, title, created, modified, revision, metadata)
     VALUES ('scene', NULL, 'group', 'Scene', 1, 1, 0, '{"memoryMode":"memories"}')`,
  ).run();
  storedUserMessage('scene', 'u', 0, null);

  upgradeLibrary(db);

  expect(row('scene')).toEqual({ metadata: '{"memoryMode":"memories"}', modified: 1, revision: 0 });
  expect(
    db
      .query<{ persona_id: string | null }, []>("SELECT persona_id FROM messages WHERE id = 'u'")
      .get()?.persona_id,
  ).toBeNull();
});
