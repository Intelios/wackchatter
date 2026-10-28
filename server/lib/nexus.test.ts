import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createChatStore } from './chats.ts';
import { createSchema } from './db.ts';
import { readNexusIndex, writeNexusIndex } from './nexus.ts';

test('Nexus cache is independent of revisions and cascades on deletion', () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createSchema(db);
  const store = createChatStore(db, { backupDir: null });
  const chat = store.createChat({ characterId: 'card.png' });
  const before = store.getChat(chat.id)!;
  writeNexusIndex(db, chat.id, [
    { documentId: 'record:a', fingerprint: 'text-a', vector: Array(384).fill(0.1) },
  ]);
  expect(readNexusIndex(db, chat.id)).toHaveLength(1);
  expect(store.getChat(chat.id)?.revision).toBe(before.revision);
  store.deleteChat(chat.id);
  expect(readNexusIndex(db, chat.id)).toHaveLength(0);
  db.close();
});

test('a cache write cannot rescue a stale story save or copy vectors into a branch', () => {
  const db = new Database(':memory:');
  createSchema(db);
  const store = createChatStore(db, { backupDir: null });
  const message = {
    id: 'source',
    name: 'Joe',
    mes: 'Joe lives in London.',
    is_user: false,
    is_system: false,
    send_date: '',
  };
  const chat = store.createChat({
    characterId: 'card.png',
    metadata: { memoryMode: 'nexus' },
    messages: [message],
  });
  const saved = store.updateChatMeta(chat.id, {
    revision: 1,
    metadata: { ...chat.metadata, variables: { story: 'new' } },
  });
  expect(saved.kind).toBe('saved');
  writeNexusIndex(db, chat.id, [
    { documentId: 'record:a', fingerprint: 'hash', vector: Array(384).fill(0.1) },
  ]);
  const stale = store.replaceChat(chat.id, {
    revision: 0,
    metadata: chat.metadata,
    messages: chat.messages,
  });
  expect(stale.kind).toBe('stale');
  expect(store.getChat(chat.id)?.metadata.variables?.story).toBe('new');
  const branch = store.branchChat(chat.id, message.id)!;
  expect(branch.metadata.memoryMode).toBe('nexus');
  expect(readNexusIndex(db, branch.id)).toHaveLength(0);
  db.close();
});

function library(): { db: Database; store: ReturnType<typeof createChatStore> } {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createSchema(db);
  return { db, store: createChatStore(db, { backupDir: null }) };
}

test('a metadata column holding null is repaired on read rather than trusted', () => {
  // parseJson returns its fallback only on a parse error, and `null` parses fine — so
  // without the repair every `metadata.<field>` read on such a row throws.
  const { db, store } = library();
  db.query(
    `INSERT INTO chats (id,character_id,kind,title,created,modified,revision,metadata)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('null-meta', 'a.png', 'direct', 'null metadata', 1, 1, 0, 'null');

  const chat = store.getChat('null-meta')!;
  expect(chat.metadata).toEqual({});
  db.close();
});
