import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createChatStore } from './chats.ts';
import { createSchema } from './db.ts';
import { migrateNexusLibrary, readNexusIndex, writeNexusIndex } from './nexus.ts';

test('Nexus cache is independent of revisions, cascades on deletion, and modes migrate once', () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createSchema(db);
  const store = createChatStore(db, { backupDir: null });
  const chat = store.createChat({ characterId: 'card.png' });
  migrateNexusLibrary(db, store, 'nexus');
  const migrated = store.getChat(chat.id)!;
  expect(migrated.metadata.memoryMode).toBe('nexus');
  writeNexusIndex(db, chat.id, [
    { documentId: 'record:a', fingerprint: 'text-a', vector: Array(384).fill(0.1) },
  ]);
  expect(readNexusIndex(db, chat.id)).toHaveLength(1);
  expect(store.getChat(chat.id)?.revision).toBe(migrated.revision);
  migrateNexusLibrary(db, store, 'classic');
  expect(store.getChat(chat.id)?.metadata.memoryMode).toBe('nexus');
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

/** One chat with an explicitly old `modified`, so any restamp is unmistakable. */
function agedChat(
  store: ReturnType<typeof createChatStore>,
  db: Database,
  title: string,
  modified: number,
) {
  const chat = store.createChat({ characterId: `${title}.png`, title });
  db.query('UPDATE chats SET modified = ? WHERE id = ?').run(modified, chat.id);
  return chat;
}

test('migrating a library leaves every chat modified timestamp alone', () => {
  // The whole point of the migration door. `updateChatMeta` stamps `modified` with
  // `Date.now()` per chat, so a first 2.0 boot dated the entire library to the boot moment
  // in loop order: the recents list reordered itself and Stats' "last spoke" claimed the
  // user had just opened everything.
  const { db, store } = library();
  const oldest = agedChat(store, db, 'oldest', 1);
  const middle = agedChat(store, db, 'middle', 2);
  const newest = agedChat(store, db, 'newest', 3);
  const before = db
    .query<{ id: string; modified: number }, []>('SELECT id, modified FROM chats')
    .all();

  migrateNexusLibrary(db, store, 'nexus');

  expect(
    db.query<{ id: string; modified: number }, []>('SELECT id, modified FROM chats').all(),
  ).toEqual(before);
  // And the order the recents list reads from is therefore identical.
  expect(store.listRecent(10).map((c) => c.id)).toEqual([newest.id, middle.id, oldest.id]);
  expect(store.listChats().map((c) => c.id)).toEqual([newest.id, middle.id, oldest.id]);
  db.close();
});

test('the migration still freezes the mode and moves the revision forward', () => {
  // Leaving recency alone must not have made the pass a no-op: the mode is the state it
  // exists to record, and the revision bump is what stops a stale tab writing back.
  const { db, store } = library();
  const chat = agedChat(store, db, 'a', 1);
  agedChat(store, db, 'b', 2);

  migrateNexusLibrary(db, store, 'nexus');

  const migrated = store.getChat(chat.id)!;
  expect(migrated.metadata.memoryMode).toBe('nexus');
  expect(migrated.modified).toBe(1);
  expect(migrated.revision).toBe(1);
  // 2 chats sharing one revision is the bump being per-chat, not a global counter.
  expect(store.listChatMetas().every((c) => c.revision === 1)).toBe(true);
  db.close();
});

test('a legacy memories chat is converted and one already carrying nexus is not overwritten', () => {
  const { db, store } = library();
  const legacy = store.createChat({
    characterId: 'a.png',
    messages: [
      { id: 'm0', name: 'Joe', mes: 'one', is_user: false, is_system: false, send_date: '' },
      { id: 'm1', name: 'Joe', mes: 'two', is_user: false, is_system: false, send_date: '' },
    ],
    metadata: {
      memories: [
        {
          id: 'mem-1',
          title: 'A scene',
          text: 'Something happened.',
          keywords: ['key'],
          pinned: false,
          enabled: true,
          source: 'generated',
          edited: false,
          generatedAt: 0,
          range: { startId: 'm0', endId: 'm1' },
        },
      ],
    },
  });
  // A chat that already has Nexus state must keep it, whatever the app default says.
  const carried = store.createChat({
    characterId: 'b.png',
    metadata: {
      memoryMode: 'off',
      nexus: { version: 1, nodes: [], records: [], processed: {}, initialized: true, paused: true },
    },
  });

  migrateNexusLibrary(db, store, 'classic');

  const migrated = store.getChat(legacy.id)!;
  expect(migrated.metadata.memories).toHaveLength(1);
  const revision = migrated.metadata.nexus?.records[0]?.revisions[0];
  expect(revision?.evidence.map((e) => e.messageId)).toEqual(['m0', 'm1']);
  expect(migrated.metadata.memoryMode).toBe('classic');
  // An established Nexus is not rebuilt from the legacy memories beside it.
  const kept = store.getChat(carried.id)!;
  expect(kept.metadata.memoryMode).toBe('off');
  expect(kept.metadata.nexus?.paused).toBe(true);
  db.close();
});

test('the legacy memories value resolves to nexus, matching how a new chat is created', () => {
  const { db, store } = library();
  const chat = agedChat(store, db, 'a', 1);

  migrateNexusLibrary(db, store, 'memories');

  expect(store.getChat(chat.id)?.metadata.memoryMode).toBe('nexus');
  db.close();
});

test('a chat that cannot be migrated does not stop the sweep or the boot', () => {
  // Two rows that used to kill the first 2.0 boot outright: metadata holding the JSON
  // literal `null` (valid JSON, so the parser's fallback never fires) and a group scene
  // that predates the director block. The first is repaired on read, the second is
  // deliberately unvalidated, so neither reaches the failure path — which is the point.
  const { db, store } = library();
  const healthy = agedChat(store, db, 'healthy', 3);
  db.query(
    `INSERT INTO chats (id,character_id,kind,title,created,modified,revision,metadata)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('null-meta', 'a.png', 'direct', 'null metadata', 1, 1, 0, 'null');
  db.query(
    `INSERT INTO chats (id,character_id,kind,title,created,modified,revision,metadata)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    'old-group',
    null,
    'group',
    'old group',
    1,
    2,
    0,
    JSON.stringify({
      group: {
        name: 'Old',
        members: [],
        scenario: '',
        generation: { connectionId: '', model: '', presetId: '' },
        concurrency: 2,
        replyLimit: 4,
        lorebookIds: [],
      },
    }),
  );

  expect(() => migrateNexusLibrary(db, store, 'classic')).not.toThrow();

  // Every chat was migrated, including the two malformed ones — they are not skipped and
  // then sealed, they are made whole and frozen like any other.
  for (const id of ['null-meta', 'old-group']) {
    const row = db
      .query<{ modified: number; revision: number; memoryMode: string | null }, [string]>(
        "SELECT modified, revision, json_extract(metadata,'$.memoryMode') AS memoryMode FROM chats WHERE id = ?",
      )
      .get(id);
    expect(row?.memoryMode).toBe('classic');
    expect(row?.revision).toBe(1);
  }
  // Their timestamps still did not move.
  expect(store.getChat('null-meta')?.modified).toBe(1);
  expect(store.getChat('old-group')?.modified).toBe(2);
  expect(store.getChat(healthy.id)?.metadata.memoryMode).toBe('classic');
  expect(
    db
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get('nexus_migrated'),
  ).not.toBeNull();
  db.close();
});

test('a chat the sweep cannot write is contained, and retried on the next start', () => {
  // The failure is injected rather than faked with a corrupt row: `parseMetadata` now
  // repairs the shapes that used to throw, so the contract left to pin is what the loop
  // does when a write fails anyway — contain it, report it, and do not seal the marker.
  const { db, store } = library();
  const poisoned = agedChat(store, db, 'poisoned', 1);
  const healthy = agedChat(store, db, 'healthy', 2);

  const failing = {
    ...store,
    migrateChatMeta: (id: string, metadata: Parameters<typeof store.migrateChatMeta>[1]) => {
      if (id === poisoned.id) throw new Error('disk went away');
      return store.migrateChatMeta(id, metadata);
    },
  };

  expect(() => migrateNexusLibrary(db, failing, 'classic')).not.toThrow();
  // The healthy chat migrated; the poisoned one was rolled back and left untouched, not
  // half-written.
  expect(store.getChat(healthy.id)?.metadata.memoryMode).toBe('classic');
  expect(store.getChat(poisoned.id)?.metadata.memoryMode).toBeUndefined();
  expect(store.getChat(poisoned.id)?.revision).toBe(0);
  // Not every chat was frozen, so the marker is withheld and the next start tries again.
  expect(db.query('SELECT value FROM meta WHERE key = ?').get('nexus_migrated')).toBeNull();

  migrateNexusLibrary(db, store, 'classic');
  expect(store.getChat(poisoned.id)?.metadata.memoryMode).toBe('classic');
  expect(store.getChat(poisoned.id)?.modified).toBe(1);
  expect(db.query('SELECT value FROM meta WHERE key = ?').get('nexus_migrated')).not.toBeNull();

  // A completed sweep is not re-run, so a mode changed afterwards is the app default
  // moving on rather than the migration overwriting it.
  db.query("UPDATE chats SET metadata = json_remove(metadata, '$.memoryMode')").run();
  migrateNexusLibrary(db, store, 'nexus');
  expect(store.getChat(poisoned.id)?.metadata.memoryMode).toBeUndefined();
  db.close();
});

test('a chat with nothing to migrate is not written at all', () => {
  // A no-op boot must not rewrite every metadata blob in the library, and must not load
  // every transcript to decide that.
  const { db, store } = library();
  const settled = store.createChat({ characterId: 'a.png', metadata: { memoryMode: 'classic' } });
  const messages = Array.from({ length: 2000 }, (_, i) => ({
    id: `m${i}`,
    name: 'Joe',
    mes: 'x'.repeat(2000),
    is_user: i % 2 === 0,
    is_system: false,
    send_date: '',
  }));
  store.replaceChat(settled.id, { revision: 1, messages });
  // Aged AFTER the save, since a whole-chat write stamps modified by design.
  db.query('UPDATE chats SET modified = ?, revision = ? WHERE id = ?').run(1, 7, settled.id);

  migrateNexusLibrary(db, store, 'classic');

  const row = db
    .query<{ modified: number; revision: number }, [string]>(
      'SELECT modified, revision FROM chats WHERE id = ?',
    )
    .get(settled.id);
  expect(row).toEqual({ modified: 1, revision: 7 });
  db.close();
});

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
  expect(store.listChatMetas().find((c) => c.id === 'null-meta')?.metadata).toEqual({});
  db.close();
});
