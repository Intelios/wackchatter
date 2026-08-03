import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chat, ChatMessage } from '../../shared/types/chat.ts';
import { type ChatSaveResult, type ChatStore, createChatStore } from './chats.ts';
import { createSchema } from './db.ts';

let store: ChatStore;
let database: Database;

beforeEach(() => {
  database = new Database(':memory:');
  // Mirrors openDatabase. foreign_keys is per-connection, so a test that forgets it
  // would silently pass the cascade check below against a database that never cascades.
  database.exec('PRAGMA foreign_keys = ON');
  createSchema(database);
  // Backup writes are file I/O on the real data dir; this suite is about the database,
  // so the store is built without the backup hook except where a test opts in.
  store = createChatStore(database, { backupDir: null });
});

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    name: 'Seraphina',
    is_user: false,
    is_system: false,
    mes: 'Hello.',
    send_date: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function saved(result: ChatSaveResult): Chat {
  expect(result.kind).toBe('saved');
  if (result.kind !== 'saved') throw new Error('Expected chat save to succeed.');
  return result.chat;
}

describe('creating and reading', () => {
  test('a new chat comes back with its messages in order', () => {
    const created = store.createChat({
      characterId: 'Seraphina.png',
      title: 'First contact',
      messages: [
        message({ mes: 'one' }),
        message({ mes: 'two', is_user: true, name: 'Jack' }),
        message({ mes: 'three' }),
      ],
    });

    const loaded = store.getChat(created.id);
    expect(loaded?.messages.map((m) => m.mes)).toEqual(['one', 'two', 'three']);
    expect(loaded?.title).toBe('First contact');
    expect(loaded?.characterId).toBe('Seraphina.png');
    expect(loaded?.revision).toBe(0);
  });

  test('an unknown id reads as null rather than throwing', () => {
    expect(store.getChat('nope')).toBeNull();
  });

  test('an untitled chat gets a default', () => {
    expect(store.createChat({ characterId: 'a.png' }).title).toBe('New chat');
    expect(store.createChat({ characterId: 'a.png', title: '   ' }).title).toBe('New chat');
  });

  test('metadata round-trips', () => {
    const created = store.createChat({
      characterId: 'a.png',
      metadata: { persona: 'jack', scenario: 'override' },
    });
    expect(store.getChat(created.id)?.metadata).toEqual({
      persona: 'jack',
      scenario: 'override',
    });
  });

  test('swipes survive the round trip', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [
        message({
          mes: 'second',
          swipes: ['first', 'second', 'third'],
          swipe_id: 1,
          swipe_info: [
            { send_date: 'a' },
            { send_date: 'b', extra: { model: 'gpt-4o' } },
            { send_date: 'c' },
          ],
        }),
      ],
    });

    const loaded = store.getChat(created.id)!.messages[0]!;
    expect(loaded.swipes).toEqual(['first', 'second', 'third']);
    expect(loaded.swipe_id).toBe(1);
    expect(loaded.mes).toBe('second');
    expect(loaded.extra?.model).toBe('gpt-4o');
  });

  test('per-swipe timestamps and extra survive the round trip', () => {
    // Reading a row must not invent a top-level send_date that overwrites the one the
    // row actually stores — the reason rowToMessage normalises directly rather than
    // routing through ChatMessage.
    const created = store.createChat({
      characterId: 'a.png',
      messages: [
        message({
          mes: 'b',
          send_date: '2026-03-03T00:00:00.000Z',
          gen_finished: '2026-03-03T00:00:09.000Z',
          swipes: ['a', 'b'],
          swipe_id: 1,
          swipe_info: [
            { send_date: '2026-03-01T00:00:00.000Z' },
            { send_date: '2026-03-03T00:00:00.000Z', extra: { token_count: 7 } },
          ],
        }),
      ],
    });

    const loaded = store.getChat(created.id)!.messages[0]!;
    expect(loaded.send_date).toBe('2026-03-03T00:00:00.000Z');
    expect(loaded.gen_finished).toBe('2026-03-03T00:00:09.000Z');
    expect(loaded.extra?.token_count).toBe(7);
    // Swipe 0 keeps its own, older timestamp.
    expect(loaded.swipe_info?.[0]?.send_date).toBe('2026-03-01T00:00:00.000Z');
  });

  test('a message with no swipe metadata at all still gets a send_date', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ send_date: '2026-04-04T00:00:00.000Z' })],
    });

    const loaded = store.getChat(created.id)!.messages[0]!;
    expect(loaded.send_date).toBe('2026-04-04T00:00:00.000Z');
  });

  test('a recorded speaker survives the round trip, in all three states', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [
        message({ is_user: true, name: 'Jack', persona_id: 'persona-1' }),
        message({ is_user: true, name: 'Jack', persona_id: null }),
        message({ is_user: true, name: 'Jack' }),
      ],
    });

    const loaded = store.getChat(created.id)!.messages;
    expect(loaded[0]!.persona_id).toBe('persona-1');
    expect(loaded[1]!.persona_id).toBeNull();
    // Missing means "speaker not recorded" — it must not come back as null.
    expect(loaded[2]!.persona_id).toBeUndefined();
    expect(Object.hasOwn(loaded[2]!, 'persona_id')).toBe(false);
  });

  test('a message whose mes disagrees with its swipe slot is repaired on write', () => {
    // The client cannot store a desynced message even by sending one.
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: 'B', swipes: ['A'], swipe_id: 0 })],
    });

    const loaded = store.getChat(created.id)!.messages[0]!;
    expect(loaded.mes).toBe('B');
    expect(loaded.swipes).toEqual(['B']);
  });
});

describe('listing', () => {
  test('the preview is the CURRENT swipe, not swipe zero', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [
        message({ mes: 'earlier' }),
        message({ mes: 'showing', swipes: ['hidden', 'showing'], swipe_id: 1 }),
      ],
    });

    const summary = store.listChats('a.png').find((c) => c.id === created.id);
    expect(summary?.lastMessage).toBe('showing');
    expect(summary?.messageCount).toBe(2);
  });

  test('an empty chat lists with an empty preview rather than null', () => {
    const created = store.createChat({ characterId: 'a.png' });
    const summary = store.listChats('a.png').find((c) => c.id === created.id);
    expect(summary?.lastMessage).toBe('');
    expect(summary?.messageCount).toBe(0);
  });

  test('a long message is truncated for the preview', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: 'x'.repeat(500) })],
    });
    const summary = store.listChats('a.png').find((c) => c.id === created.id);
    expect(summary?.lastMessage.length).toBe(200);
  });

  test('filtering by character excludes other characters chats', () => {
    store.createChat({ characterId: 'a.png' });
    store.createChat({ characterId: 'b.png' });

    expect(store.listChats('a.png').length).toBe(1);
    expect(store.listChats().length).toBe(2);
  });

  test('the newest-modified chat sorts first', () => {
    const older = store.createChat({ characterId: 'a.png', title: 'older' });
    const newer = store.createChat({ characterId: 'a.png', title: 'newer' });
    // createChat stamps both with Date.now(); nudge the older one back explicitly.
    database.query('UPDATE chats SET modified = ? WHERE id = ?').run(1, older.id);

    expect(store.listChats('a.png')[0]?.id).toBe(newer.id);
  });

  test('listRecent returns at most limit chats across all characters', () => {
    store.createChat({ characterId: 'a.png', title: 'one' });
    store.createChat({ characterId: 'b.png', title: 'two' });
    store.createChat({ characterId: 'c.png', title: 'three' });

    const recent = store.listRecent(2);
    expect(recent.length).toBe(2);
  });

  test('listRecent sorts by modified descending', () => {
    const oldest = store.createChat({ characterId: 'a.png', title: 'oldest' });
    const middle = store.createChat({ characterId: 'b.png', title: 'middle' });
    const newest = store.createChat({ characterId: 'c.png', title: 'newest' });
    database.query('UPDATE chats SET modified = ? WHERE id = ?').run(1, oldest.id);
    database.query('UPDATE chats SET modified = ? WHERE id = ?').run(2, middle.id);
    database.query('UPDATE chats SET modified = ? WHERE id = ?').run(3, newest.id);

    const recent = store.listRecent(10);
    expect(recent.map((c) => c.id)).toEqual([newest.id, middle.id, oldest.id]);
  });

  test('listRecent returns all when limit exceeds count', () => {
    store.createChat({ characterId: 'a.png' });
    store.createChat({ characterId: 'b.png' });

    expect(store.listRecent(100).length).toBe(2);
  });
});

describe('replacing', () => {
  test('a shorter message list leaves no orphans and positions stay dense', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: '1' }), message({ mes: '2' }), message({ mes: '3' })],
    });

    store.replaceChat(created.id, { revision: 1, messages: [message({ mes: 'only' })] });

    expect(store.getChat(created.id)?.messages.map((m) => m.mes)).toEqual(['only']);

    const positions = database
      .query<{ position: number }, [string]>(
        'SELECT position FROM messages WHERE chat_id = ? ORDER BY position',
      )
      .all(created.id)
      .map((row) => row.position);
    expect(positions).toEqual([0]);
  });

  test('replacing bumps modified', () => {
    const created = store.createChat({ characterId: 'a.png' });
    database.query('UPDATE chats SET modified = ? WHERE id = ?').run(1, created.id);

    store.replaceChat(created.id, { revision: 1, messages: [message()] });
    expect(store.getChat(created.id)!.modified).toBeGreaterThan(1);
  });

  test('replacing an unknown chat reports notFound', () => {
    expect(store.replaceChat('nope', { revision: 1, messages: [] })).toEqual({ kind: 'notFound' });
  });

  test('title and metadata can be changed alongside messages', () => {
    const created = store.createChat({ characterId: 'a.png', title: 'old' });
    const updated = saved(
      store.replaceChat(created.id, {
        revision: 1,
        title: 'new',
        metadata: { persona: 'jack' },
        messages: [message()],
      }),
    );

    expect(updated.title).toBe('new');
    expect(updated.metadata).toEqual({ persona: 'jack' });
  });

  test('omitting title and metadata leaves them alone', () => {
    const created = store.createChat({
      characterId: 'a.png',
      title: 'keep me',
      metadata: { persona: 'jack' },
    });

    const updated = saved(store.replaceChat(created.id, { revision: 1, messages: [message()] }));
    expect(updated.title).toBe('keep me');
    expect(updated.metadata).toEqual({ persona: 'jack' });
  });

  test('an equal revision is idempotent but an older conflicting snapshot is rejected', () => {
    const created = store.createChat({ characterId: 'a.png' });
    const next = {
      revision: 1,
      title: 'saved once',
      metadata: { persona: null },
      messages: [message({ mes: 'new transcript' })],
    };

    expect(saved(store.replaceChat(created.id, next)).revision).toBe(1);
    expect(saved(store.replaceChat(created.id, next)).title).toBe('saved once');

    expect(
      store.replaceChat(created.id, {
        revision: 0,
        title: 'stale title',
        metadata: {},
        messages: [],
      }),
    ).toEqual({ kind: 'stale', conflict: { code: 'stale_revision', currentRevision: 1 } });
    expect(store.getChat(created.id)?.title).toBe('saved once');
  });
});

describe('schema migration', () => {
  test('adds revision to a v1 database without losing its chat or messages', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY, character_id TEXT NOT NULL, title TEXT NOT NULL,
        created INTEGER NOT NULL, modified INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE messages (
        chat_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
        is_user INTEGER NOT NULL, is_system INTEGER NOT NULL, swipe_id INTEGER NOT NULL DEFAULT 0,
        swipes TEXT NOT NULL, swipe_info TEXT NOT NULL, PRIMARY KEY (chat_id, id)
      ) WITHOUT ROWID;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      INSERT INTO chats VALUES ('legacy', 'a.png', 'Old chat', 1, 2, '{}');
      INSERT INTO messages VALUES ('legacy', 'm1', 0, 'User', 1, 0, 0, '["hello"]', '[{"send_date":""}]');
    `);

    createSchema(legacy);
    const migrated = createChatStore(legacy, { backupDir: null }).getChat('legacy');

    expect(migrated?.revision).toBe(0);
    expect(migrated?.title).toBe('Old chat');
    expect(migrated?.messages.map((item) => item.mes)).toEqual(['hello']);
    expect(
      legacy
        .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
        .get('schema_version')?.value,
    ).toBe('3');
  });

  test('adds persona_id to a v2 database without losing its messages', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY, character_id TEXT NOT NULL, title TEXT NOT NULL,
        created INTEGER NOT NULL, modified INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE messages (
        chat_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
        is_user INTEGER NOT NULL, is_system INTEGER NOT NULL, swipe_id INTEGER NOT NULL DEFAULT 0,
        swipes TEXT NOT NULL, swipe_info TEXT NOT NULL, PRIMARY KEY (chat_id, id)
      ) WITHOUT ROWID;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '2');
      INSERT INTO chats VALUES ('legacy', 'a.png', 'Old chat', 1, 2, 5, '{}');
      INSERT INTO messages VALUES ('legacy', 'm1', 0, 'User', 1, 0, 0, '["hello"]', '[{"send_date":""}]');
    `);

    createSchema(legacy);
    const migrated = createChatStore(legacy, { backupDir: null }).getChat('legacy');

    expect(migrated?.revision).toBe(5);
    expect(migrated?.messages.map((item) => item.mes)).toEqual(['hello']);
    // A row from before speakers were recorded reads as unrecorded, not as no-persona.
    expect(migrated?.messages[0]?.persona_id).toBeUndefined();
    expect(
      legacy
        .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
        .get('schema_version')?.value,
    ).toBe('3');
  });
});

describe('renaming and deleting', () => {
  test('updateChatMeta changes the title without touching messages', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: 'kept' })],
    });

    const renamed = saved(store.updateChatMeta(created.id, { revision: 1, title: 'Renamed' }));
    expect(renamed.title).toBe('Renamed');
    expect(renamed.messages.map((m) => m.mes)).toEqual(['kept']);
  });

  test('deleting a chat cascades to its messages', () => {
    // Fails loudly if PRAGMA foreign_keys was not set on this connection.
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message(), message(), message()],
    });

    expect(store.deleteChat(created.id)).toBe(true);
    expect(store.getChat(created.id)).toBeNull();

    const orphans = database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?',
      )
      .get(created.id);
    expect(orphans?.count).toBe(0);
  });

  test('deleting an unknown chat reports false', () => {
    expect(store.deleteChat('nope')).toBe(false);
  });
});

describe('character identity cascades', () => {
  test('reassignCharacter moves every chat to the new identity', () => {
    const kept = store.createChat({ characterId: 'Old.png', title: 'one' });
    store.createChat({ characterId: 'Old.png', title: 'two' });
    const other = store.createChat({ characterId: 'Other.png', title: 'three' });

    expect(store.reassignCharacter('Old.png', 'New.png')).toBe(2);

    // The transcripts now list under the renamed card, not the old one.
    expect(store.listChats('Old.png')).toEqual([]);
    expect(
      store
        .listChats('New.png')
        .map((c) => c.title)
        .sort(),
    ).toEqual(['one', 'two']);
    expect(store.getChat(kept.id)?.characterId).toBe('New.png');

    // An unrelated character is untouched.
    expect(store.listChats('Other.png').map((c) => c.id)).toEqual([other.id]);
  });

  test('reassignCharacter preserves messages and metadata', () => {
    const created = store.createChat({
      characterId: 'Old.png',
      metadata: { persona: 'jack' },
      messages: [message({ mes: 'kept' })],
    });

    store.reassignCharacter('Old.png', 'New.png');

    const loaded = store.getChat(created.id);
    expect(loaded?.characterId).toBe('New.png');
    expect(loaded?.metadata).toEqual({ persona: 'jack' });
    expect(loaded?.messages.map((m) => m.mes)).toEqual(['kept']);
  });

  test('reassigning to the same identity is a no-op', () => {
    store.createChat({ characterId: 'Same.png' });
    expect(store.reassignCharacter('Same.png', 'Same.png')).toBe(0);
    expect(store.listChats('Same.png').length).toBe(1);
  });

  test('deleteChatsForCharacter removes only that character chats, messages and all', () => {
    const doomed = store.createChat({ characterId: 'Gone.png', messages: [message(), message()] });
    const survivor = store.createChat({ characterId: 'Kept.png', messages: [message()] });

    expect(store.deleteChatsForCharacter('Gone.png')).toBe(1);

    expect(store.getChat(doomed.id)).toBeNull();
    expect(store.listChats('Gone.png')).toEqual([]);
    expect(store.getChat(survivor.id)?.id).toBe(survivor.id);

    // The deleted chat's messages cascaded away rather than orphaning.
    const orphans = database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?',
      )
      .get(doomed.id);
    expect(orphans?.count).toBe(0);
  });

  test('deleteChatsForCharacter on an unknown character reports zero', () => {
    expect(store.deleteChatsForCharacter('Nobody.png')).toBe(0);
  });
});

describe('backups on delete', () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'wc-chat-backups-'));
    store = createChatStore(database, { backupDir });
  });

  afterEach(() => {
    rmSync(backupDir, { recursive: true, force: true });
  });

  test('deleting a chat writes a backup file holding the full chat', () => {
    const doomed = store.createChat({
      characterId: 'a.png',
      title: 'Doomed',
      metadata: { persona: 'jack' },
      messages: [message({ mes: 'kept' })],
    });

    expect(store.deleteChat(doomed.id)).toBe(true);
    expect(readdirSync(backupDir).length).toBe(1);
    const files = readdirSync(backupDir);
    expect(files[0]).toMatch(/^\d+__Doomed__.+\.json$/);
    expect(JSON.parse(readFileSync(join(backupDir, files[0]!), 'utf8'))).toEqual(doomed);
  });

  test('deleting an unknown chat writes nothing', () => {
    expect(store.deleteChat('nope')).toBe(false);
    expect(readdirSync(backupDir)).toEqual([]);
  });

  test('a character cascade backs up every one of its chats, and only its own', () => {
    store.createChat({ characterId: 'Gone.png', title: 'one', messages: [message()] });
    store.createChat({ characterId: 'Gone.png', title: 'two', messages: [message()] });
    store.createChat({ characterId: 'Kept.png', title: 'three' });

    expect(store.deleteChatsForCharacter('Gone.png')).toBe(2);
    expect(readdirSync(backupDir).length).toBe(2);
  });

  test('a failed backup aborts the delete and leaves the chat', () => {
    const doomed = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: 'still here' })],
    });
    store = createChatStore(database, { backupDir: join(backupDir, 'does-not-exist') });

    // The directory is gone, so the backup write throws before any row is removed.
    expect(() => store.deleteChat(doomed.id)).toThrow();
    expect(store.getChat(doomed.id)?.messages.map((m) => m.mes)).toEqual(['still here']);
  });
});

describe('branching', () => {
  test('a branch copies messages up to and including the branch point', () => {
    const created = store.createChat({
      characterId: 'a.png',
      title: 'Original',
      messages: [message({ mes: '1' }), message({ mes: '2' }), message({ mes: '3' })],
    });

    const branchPoint = store.getChat(created.id)!.messages[1]!.id;
    const branch = store.branchChat(created.id, branchPoint)!;

    expect(branch.id).not.toBe(created.id);
    expect(branch.messages.map((m) => m.mes)).toEqual(['1', '2']);
    expect(branch.title).toBe('Original (branch)');
    expect(branch.characterId).toBe('a.png');

    // The original is untouched.
    expect(store.getChat(created.id)?.messages.length).toBe(3);
  });

  test('branched messages get fresh ids so the two chats stay independent', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: '1' })],
    });
    const original = store.getChat(created.id)!.messages[0]!;
    const branch = store.branchChat(created.id, original.id)!;

    expect(branch.messages[0]?.id).not.toBe(original.id);
    expect(branch.messages[0]?.mes).toBe('1');
  });

  test('a branch preserves swipe arrays', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: 'b', swipes: ['a', 'b'], swipe_id: 1 })],
    });
    const target = store.getChat(created.id)!.messages[0]!;
    const branch = store.branchChat(created.id, target.id)!;

    expect(branch.messages[0]?.swipes).toEqual(['a', 'b']);
    expect(branch.messages[0]?.swipe_id).toBe(1);
  });

  test('an unknown chat or message returns null', () => {
    const created = store.createChat({ characterId: 'a.png', messages: [message()] });
    expect(store.branchChat('nope', 'x')).toBeNull();
    expect(store.branchChat(created.id, 'not-a-message')).toBeNull();
  });
});
