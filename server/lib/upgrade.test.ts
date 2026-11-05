import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  expect(written).toMatchObject({ memoryMode: 'nexus', personaId: 'ari', streamingFps: 30 });
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
  // Already holding `models`, so only the chat step has anything to do.
  settings({ memoryMode: 'nexus', personaId: 'ari', models: {} });
  storedChat('aged', JSON.stringify({}), 42);
  storedChat('converted', JSON.stringify({ memoryMode: 'nexus', persona: 'ari' }), 7);

  expect(upgradeLibrary(db)).toBe(false);
  const after = row('aged');
  expect(after.modified).toBe(42);
  expect(after.revision).toBeGreaterThan(3);
  // Nothing to convert, nothing written.
  expect(row('converted').revision).toBe(3);

  db.query("UPDATE chats SET metadata = '{}' WHERE id = 'aged'").run();
  // Both steps are recorded as run, so a later boot runs neither.
  upgradeLibrary(db);
  expect(row('aged').metadata).toBe('{}');
  expect(
    db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'conversion_step'").get()
      ?.value,
  ).toBe('2');
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

describe('models', () => {
  const connections = [
    {
      id: 'or',
      name: 'OpenRouter',
      provider: 'openrouter',
      baseUrl: 'https://or/v1',
      model: 'or/chat',
    },
    { id: 'local', name: 'Local', provider: 'custom', baseUrl: 'http://local/v1', model: 'llama' },
  ];

  test('every old connection/model pair becomes the slot it meant, and connections lose their model', () => {
    settings({
      connections,
      connectionId: 'local',
      summary: { connectionId: 'or', targetWords: 150 },
      nexus: { connectionId: 'or', model: 'or/memory', inputTokens: 9000 },
      coCreator: {
        connectionId: null,
        presetId: 'p',
        sideChat: {
          connectionId: 'or',
          modelOverride: { connectionId: 'or', model: 'or/side' },
          outputTokens: 512,
        },
      },
      arena: {
        contenders: [
          { id: 'c1', name: 'Own', connectionId: 'or', model: 'or/x', enabled: true },
          { id: 'c2', name: 'Follows', connectionId: 'local', model: '', enabled: false },
          { id: 'c3', name: 'Gone', connectionId: 'deleted', model: '', enabled: true },
        ],
      },
    });

    expect(upgradeLibrary(db)).toBe(true);
    const written = JSON.parse(readFileSync(PATHS.settings, 'utf8'));

    expect(written.models).toEqual({
      chat: { connectionId: 'local', modelId: 'llama' },
      summary: { connectionId: 'or', modelId: 'or/chat' },
      nexus: { connectionId: 'or', modelId: 'or/memory' },
      // No connection meant "follow chat" — which an empty slot still means.
      cocreator: null,
      sideChat: { connectionId: 'or', modelId: 'or/side' },
    });
    expect(written.recentModels[0]).toEqual({ connectionId: 'local', modelId: 'llama' });
    expect(written.recentModels).toHaveLength(4);
    expect(written.connections.map((c: Record<string, unknown>) => 'model' in c)).toEqual([
      false,
      false,
    ]);
    expect(written).not.toHaveProperty('connectionId');
    expect(written.summary).toEqual({ targetWords: 150 });
    expect(written.nexus).toEqual({ inputTokens: 9000 });
    expect(written.coCreator).toEqual({ presetId: 'p', sideChat: { outputTokens: 512 } });
    expect(written.arena.contenders).toEqual([
      { id: 'c1', name: 'Own', model: { connectionId: 'or', modelId: 'or/x' }, enabled: true },
      {
        id: 'c2',
        name: 'Follows',
        model: { connectionId: 'local', modelId: 'llama' },
        enabled: false,
      },
      { id: 'c3', name: 'Gone', model: null, enabled: true },
    ]);
  });

  test('with no selection, chat runs on the first connection, as 2.3 did', () => {
    settings({ connections, connectionId: 'deleted' });
    upgradeLibrary(db);
    const written = JSON.parse(readFileSync(PATHS.settings, 'utf8'));
    expect(written.models.chat).toEqual({ connectionId: 'or', modelId: 'or/chat' });
  });

  test('Co-Creator sessions and their side chats keep the model they ran on', () => {
    settings({ connections, connectionId: 'or' });
    const insert = db.query(
      `INSERT INTO cocreator_sessions (id, title, created, modified, revision, settings, side_chat)
       VALUES (?, 't', 1, 50, 4, ?, ?)`,
    );
    insert.run(
      'override',
      JSON.stringify({
        connectionId: 'or',
        modelOverride: { connectionId: 'or', model: 'or/pick' },
        outputTokens: 900,
      }),
      JSON.stringify({ snapshot: { x: 1 }, settings: { connectionId: 'local' }, messages: [] }),
    );
    insert.run('follows', JSON.stringify({ connectionId: null, presetId: 'p' }), null);
    insert.run('untouched', JSON.stringify({ presetId: 'p' }), null);

    upgradeLibrary(db);

    const session = (id: string) =>
      db
        .query<
          { settings: string; side_chat: string | null; modified: number; revision: number },
          [string]
        >('SELECT settings, side_chat, modified, revision FROM cocreator_sessions WHERE id = ?')
        .get(id)!;
    expect(JSON.parse(session('override').settings)).toEqual({
      model: { connectionId: 'or', modelId: 'or/pick' },
      outputTokens: 900,
    });
    expect(JSON.parse(session('override').side_chat!)).toEqual({
      snapshot: { x: 1 },
      settings: { model: { connectionId: 'local', modelId: 'llama' } },
      messages: [],
    });
    expect(session('override').modified).toBe(50);
    expect(session('override').revision).toBe(5);
    expect(JSON.parse(session('follows').settings)).toEqual({ presetId: 'p' });
    expect(session('untouched').revision).toBe(4);
  });

  test('Preset Co-Creator documents convert the assistant, the tester and each test', () => {
    settings({ connections, connectionId: 'or' });
    const document = {
      settings: {
        assistant: { connectionId: 'or', model: '', maxTokens: 10 },
        testing: { connectionId: null, model: '', maxTokens: 20 },
        assistantInstructions: '',
      },
      tests: [{ id: 't', testingSettings: { connectionId: 'local', model: 'big', maxTokens: 30 } }],
      messages: [],
    };
    db.query(
      `INSERT INTO preset_cocreator_sessions (id, title, created, modified, document_revision, document)
       VALUES ('d', 't', 1, 1, 2, ?)`,
    ).run(JSON.stringify(document));

    upgradeLibrary(db);

    const stored = db
      .query<{ document: string; document_revision: number }, []>(
        "SELECT document, document_revision FROM preset_cocreator_sessions WHERE id = 'd'",
      )
      .get()!;
    const converted = JSON.parse(stored.document);
    expect(converted.settings.assistant).toEqual({
      model: { connectionId: 'or', modelId: 'or/chat' },
      maxTokens: 10,
    });
    expect(converted.settings.testing).toEqual({ model: null, maxTokens: 20 });
    expect(converted.tests[0].testingSettings).toEqual({
      model: { connectionId: 'local', modelId: 'big' },
      maxTokens: 30,
    });
    expect(stored.document_revision).toBe(3);
  });

  test('a rerun after settings were converted changes nothing', () => {
    settings({ connections, connectionId: 'local' });
    upgradeLibrary(db);
    const once = readFileSync(PATHS.settings, 'utf8');

    // As if the process died before the marker landed.
    db.query("DELETE FROM meta WHERE key = 'conversion_step'").run();
    expect(upgradeLibrary(db)).toBe(false);
    expect(readFileSync(PATHS.settings, 'utf8')).toBe(once);
  });
});
