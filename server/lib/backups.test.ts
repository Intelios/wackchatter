import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Chat, ChatMessage } from '../../shared/types/chat.ts';
import {
  MAX_CHAT_BACKUPS,
  deleteChatBackup,
  listChatBackups,
  parseChatExport,
  readChatBackup,
  restoreChatBackup,
  writeChatBackup,
} from './backups.ts';
import { type ChatStore, createChatStore } from './chats.ts';
import { createSchema } from './db.ts';

let dir: string;
let store: ChatStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-backups-'));
  const database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createSchema(database);
  store = createChatStore(database, { backupDir: null });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: crypto.randomUUID(),
    characterId: 'Seraphina.png',
    title: 'First contact',
    created: 1,
    modified: 2,
    revision: 3,
    metadata: { persona: 'jack' },
    messages: [
      {
        id: crypto.randomUUID(),
        name: 'User',
        is_user: true,
        is_system: false,
        mes: 'Hello.',
        send_date: '2026-01-01T00:00:00.000Z',
      } satisfies ChatMessage,
    ],
    ...overrides,
  };
}

function fileNames(): string[] {
  return readdirSync(dir).filter((file) => file.endsWith('.json'));
}

describe('writeChatBackup', () => {
  test('writes the full chat to a .json file in the backup directory', () => {
    writeChatBackup(chat(), dir);

    const files = fileNames();
    expect(files.length).toBe(1);
    const parsed = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Chat;
    expect(parsed.title).toBe('First contact');
    expect(parsed.characterId).toBe('Seraphina.png');
    expect(parsed.messages.map((m) => m.mes)).toEqual(['Hello.']);
    expect(parsed.metadata).toEqual({ persona: 'jack' });
  });

  test('the filename carries a timestamp, the title, and the chat id', () => {
    const doomed = chat({ title: 'My Story (2)' });
    writeChatBackup(doomed, dir);

    const [name] = fileNames();
    expect(name).toMatch(new RegExp(`^\\d+__My Story \\(2\\)__${doomed.id}\\.json$`));
  });

  test('an untitled chat still gets a readable filename', () => {
    writeChatBackup(chat({ title: '   ' }), dir);
    expect(fileNames()[0]).toMatch(/^\d+__untitled__/);
  });

  test('two backups in the same millisecond stay distinct', () => {
    writeChatBackup(chat(), dir);
    writeChatBackup(chat(), dir);
    expect(fileNames().length).toBe(2);
  });

  test('writes past the cap prune the oldest first', async () => {
    for (let i = 0; i < MAX_CHAT_BACKUPS + 5; i++) {
      writeChatBackup(chat({ title: `c${i}` }), dir);
      // Distinct prefixes keep the directory order strictly chronological — otherwise
      // two same-millisecond writes fall back to title ordering in the sort.
      await Bun.sleep(2);
    }
    const survivors = fileNames().sort();
    expect(survivors.length).toBe(MAX_CHAT_BACKUPS);
    const titles = survivors.map((file) => file.split('__')[1]);
    // The five earliest writes are exactly the ones pruned.
    expect(titles[0]).toBe('c5');
    expect(titles[titles.length - 1]).toBe(`c${MAX_CHAT_BACKUPS + 4}`);
    expect(titles).not.toContain('c0');
  });
});

describe('listChatBackups', () => {
  test('returns summaries for every backup, newest first', async () => {
    const a = chat({ title: 'older' });
    const b = chat({ title: 'newer' });
    writeChatBackup(a, dir);
    await Bun.sleep(2);
    writeChatBackup(b, dir);

    const list = listChatBackups(undefined, dir);
    expect(list.map((s) => s.title)).toEqual(['newer', 'older']);
    expect(list[0]).toMatchObject({
      chatId: b.id,
      characterId: 'Seraphina.png',
      messageCount: 1,
    });
    expect(list[0]!.deleted).toBeGreaterThan(0);
    expect(list[0]!.backupId.length).toBeGreaterThan(0);
  });

  test('filters by character', () => {
    writeChatBackup(chat(), dir);
    writeChatBackup(chat({ characterId: 'Other.png' }), dir);

    expect(listChatBackups('Seraphina.png', dir).length).toBe(1);
    expect(listChatBackups('Other.png', dir)[0]?.characterId).toBe('Other.png');
    expect(listChatBackups(undefined, dir).length).toBe(2);
  });

  test('a corrupt file is skipped rather than fatal', () => {
    writeChatBackup(chat(), dir);
    // A torn write or an interfering hand: still listed as a file, never as a chat.
    const file = fileNames()[0]!;
    writeFileSync(join(dir, file), '{ not json');
    expect(listChatBackups(undefined, dir)).toEqual([]);
  });

  test('an empty or missing directory lists nothing', () => {
    expect(listChatBackups(undefined, join(dir, 'nope'))).toEqual([]);
  });
});

describe('readChatBackup', () => {
  test('round-trips the chat it was written from', () => {
    const doomed = chat();
    writeChatBackup(doomed, dir);
    const backupId = fileNames()[0]!.slice(0, -'.json'.length);

    const loaded = readChatBackup(backupId, dir);
    expect(loaded).toEqual(doomed);
  });

  test('returns null for a missing or unreadable backup', () => {
    expect(readChatBackup('never-wrote-this', dir)).toBeNull();
  });

  test('a backup id cannot escape the backup directory', () => {
    expect(readChatBackup('../../etc/passwd', dir)).toBeNull();
  });
});

describe('deleteChatBackup', () => {
  test('removes the file and reports success', () => {
    writeChatBackup(chat(), dir);
    const backupId = fileNames()[0]!.slice(0, -'.json'.length);

    expect(deleteChatBackup(backupId, dir)).toBe(true);
    expect(fileNames().length).toBe(0);
  });

  test('a missing backup reports false', () => {
    expect(deleteChatBackup('nothing-here', dir)).toBe(false);
  });
});

describe('restoreChatBackup', () => {
  test('recreates the chat with a fresh id and removes the file', () => {
    const doomed = chat();
    writeChatBackup(doomed, dir);
    const backupId = fileNames()[0]!.slice(0, -'.json'.length);

    const restored = restoreChatBackup(backupId, store, dir);
    expect(restored).not.toBeNull();
    expect(restored!.id).not.toBe(doomed.id);
    expect(restored!.revision).toBe(0);
    expect(restored!.title).toBe(doomed.title);
    expect(restored!.characterId).toBe(doomed.characterId);
    expect(restored!.metadata).toEqual(doomed.metadata);
    expect(restored!.messages.map((m) => m.mes)).toEqual(doomed.messages.map((m) => m.mes));
    // The bin is empty again: a second restore is impossible rather than a duplicate.
    expect(fileNames().length).toBe(0);
    expect(store.getChat(restored!.id)?.messages.length).toBe(1);
  });

  test('a missing backup restores nothing', () => {
    expect(restoreChatBackup('nothing-here', store, dir)).toBeNull();
  });

  test('a corrupt backup restores nothing and stays in the bin', () => {
    writeChatBackup(chat(), dir);
    const file = fileNames()[0]!;
    writeFileSync(join(dir, file), '{ not json');

    expect(restoreChatBackup(file.slice(0, -'.json'.length), store, dir)).toBeNull();
    expect(fileNames().length).toBe(1);
  });
});

describe('parseChatExport', () => {
  test('accepts a chat and keeps title, metadata and messages', () => {
    const parsed = parseChatExport(chat());
    expect(parsed).toMatchObject({
      title: 'First contact',
      metadata: { persona: 'jack' },
    });
    expect(parsed?.messages.map((m) => m.mes)).toEqual(['Hello.']);
  });

  test('rejects things that are not a chat export', () => {
    for (const garbage of [null, 'text', 42, {}, { messages: 'nope' }, { messages: [] }]) {
      expect(parseChatExport(garbage), String(garbage)).toBeNull();
    }
  });
});
