import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../../shared/types/chat.ts';
import { type ChatStore, createChatStore } from './chats.ts';
import { createSchema } from './db.ts';

let store: ChatStore;
let database: Database;

beforeEach(() => {
  database = new Database(':memory:');
  // Mirrors openDatabase. foreign_keys is per-connection, so a test that forgets it
  // would silently pass the cascade check below against a database that never cascades.
  database.exec('PRAGMA foreign_keys = ON');
  createSchema(database);
  store = createChatStore(database);
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
});

describe('replacing', () => {
  test('a shorter message list leaves no orphans and positions stay dense', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: '1' }), message({ mes: '2' }), message({ mes: '3' })],
    });

    store.replaceChat(created.id, { messages: [message({ mes: 'only' })] });

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

    store.replaceChat(created.id, { messages: [message()] });
    expect(store.getChat(created.id)!.modified).toBeGreaterThan(1);
  });

  test('replacing an unknown chat returns null', () => {
    expect(store.replaceChat('nope', { messages: [] })).toBeNull();
  });

  test('title and metadata can be changed alongside messages', () => {
    const created = store.createChat({ characterId: 'a.png', title: 'old' });
    const updated = store.replaceChat(created.id, {
      title: 'new',
      metadata: { persona: 'jack' },
      messages: [message()],
    });

    expect(updated?.title).toBe('new');
    expect(updated?.metadata).toEqual({ persona: 'jack' });
  });

  test('omitting title and metadata leaves them alone', () => {
    const created = store.createChat({
      characterId: 'a.png',
      title: 'keep me',
      metadata: { persona: 'jack' },
    });

    const updated = store.replaceChat(created.id, { messages: [message()] });
    expect(updated?.title).toBe('keep me');
    expect(updated?.metadata).toEqual({ persona: 'jack' });
  });
});

describe('renaming and deleting', () => {
  test('updateChatMeta changes the title without touching messages', () => {
    const created = store.createChat({
      characterId: 'a.png',
      messages: [message({ mes: 'kept' })],
    });

    const renamed = store.updateChatMeta(created.id, { title: 'Renamed' });
    expect(renamed?.title).toBe('Renamed');
    expect(renamed?.messages.map((m) => m.mes)).toEqual(['kept']);
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
