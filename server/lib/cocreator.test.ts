import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { emptyStash, setSlot } from '../../shared/cocreator/stash.ts';
import type { ChatMessage } from '../../shared/types/chat.ts';
import type { CardStash, CocreatorSession, StashProvenance } from '../../shared/types/cocreator.ts';
import {
  type CocreatorSaveResult,
  type CocreatorStore,
  createCocreatorStore,
  normalizeExamples,
  normalizeSessionSettings,
} from './cocreator.ts';
import { createSchema } from './db.ts';

let store: CocreatorStore;
let database: Database;

beforeEach(() => {
  database = new Database(':memory:');
  // Mirrors openDatabase. foreign_keys is per-connection, so a test that forgets it would
  // silently pass the cascade check below against a database that never cascades.
  database.exec('PRAGMA foreign_keys = ON');
  createSchema(database);
  store = createCocreatorStore(database);
});

const provenance: StashProvenance = {
  messageId: 'm1',
  swipeIndex: 0,
  at: '2026-08-13T10:00:00.000Z',
  source: 'block',
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    name: 'message',
    is_user: false,
    is_system: false,
    mes: 'Hello.',
    send_date: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function saved(result: CocreatorSaveResult): CocreatorSession {
  expect(result.kind).toBe('saved');
  if (result.kind !== 'saved') throw new Error('Expected the save to succeed.');
  return result.session;
}

function filledStash(): CardStash {
  let stash = setSlot(emptyStash(), 'description', 'Tall and tired.', provenance);
  stash = setSlot(stash, 'alternate_greeting', 'The lanterns are lit.', provenance);
  stash = setSlot(stash, 'tags', 'gothic, keeper', provenance);
  return stash;
}

describe('creating and reading', () => {
  test('a new session starts empty at revision 0', () => {
    const session = store.createSession({});

    expect(session.revision).toBe(0);
    expect(session.title).toBe('Untitled session');
    expect(session.messages).toEqual([]);
    expect(session.stash).toEqual(emptyStash());
    expect(session.examples.cards).toEqual([]);
    expect(session.settings).toEqual({});
    expect(session.avatar).toBeNull();
    expect(session.finishedAvatar).toBeNull();
  });

  test('stash, examples and settings round-trip through their JSON columns', () => {
    const created = store.createSession({ title: 'Gothic lighthouse keeper' });
    saved(
      store.replaceSession(created.id, {
        revision: 1,
        stash: filledStash(),
        examples: {
          cards: ['Seraphina.png'],
          fields: { ...created.examples.fields, mes_example: true },
        },
        settings: { connectionId: 'c1', presetId: null, systemPrompt: 'Custom.' },
        messages: [message({ mes: 'Hi.' })],
      }),
    );

    const read = store.getSession(created.id)!;
    expect(read.title).toBe('Gothic lighthouse keeper');
    expect(read.stash.description?.text).toBe('Tall and tired.');
    expect(read.stash.alternate_greetings).toHaveLength(1);
    expect(read.stash.tags.map((entry) => entry.text)).toEqual(['gothic', 'keeper']);
    expect(read.examples.cards).toEqual(['Seraphina.png']);
    expect(read.examples.fields.mes_example).toBe(true);
    expect(read.settings).toEqual({ connectionId: 'c1', presetId: null, systemPrompt: 'Custom.' });
    expect(read.messages.map((entry) => entry.mes)).toEqual(['Hi.']);
  });

  test('an unknown id reads as null rather than throwing', () => {
    expect(store.getSession('nope')).toBeNull();
  });
});

describe('the revision race', () => {
  test('a save below the stored revision is stale and reports the current one', () => {
    const created = store.createSession({});
    saved(store.replaceSession(created.id, { revision: 3, messages: [message()] }));

    const result = store.replaceSession(created.id, { revision: 2, messages: [] });
    expect(result).toEqual({
      kind: 'stale',
      conflict: { code: 'stale_revision', currentRevision: 3 },
    });
  });

  test('a repeat of the same revision with identical content succeeds — a retry is idempotent', () => {
    const created = store.createSession({});
    const first = saved(
      store.replaceSession(created.id, {
        revision: 1,
        title: 'Keeper',
        messages: [message({ id: 'm1', mes: 'Hi.' })],
      }),
    );

    const again = saved(
      store.replaceSession(created.id, {
        revision: 1,
        title: 'Keeper',
        messages: [message({ id: 'm1', mes: 'Hi.' })],
      }),
    );
    expect(again.revision).toBe(first.revision);
    expect(again.messages.map((entry) => entry.mes)).toEqual(['Hi.']);
  });

  test('the same revision with different content is stale', () => {
    const created = store.createSession({});
    saved(store.replaceSession(created.id, { revision: 1, messages: [message({ mes: 'Hi.' })] }));

    const result = store.replaceSession(created.id, {
      revision: 1,
      messages: [message({ mes: 'Different.' })],
    });
    expect(result.kind).toBe('stale');
  });

  test('a stash change alone is enough to make the same revision stale', () => {
    const created = store.createSession({});
    saved(store.replaceSession(created.id, { revision: 1, messages: [] }));

    expect(
      store.replaceSession(created.id, { revision: 1, stash: filledStash(), messages: [] }).kind,
    ).toBe('stale');
  });

  test('saving an unknown session is notFound, not a silent create', () => {
    expect(store.replaceSession('nope', { revision: 1, messages: [] })).toEqual({
      kind: 'notFound',
    });
    expect(store.patchSession('nope', { revision: 1 })).toEqual({ kind: 'notFound' });
  });
});

describe('patching', () => {
  test('a patch never rewrites the transcript', () => {
    const created = store.createSession({});
    saved(store.replaceSession(created.id, { revision: 1, messages: [message({ mes: 'Kept.' })] }));

    const patched = saved(store.patchSession(created.id, { revision: 2, title: 'Renamed' }));
    expect(patched.title).toBe('Renamed');
    expect(patched.messages.map((entry) => entry.mes)).toEqual(['Kept.']);
  });

  test('recording the finished card leaves everything else alone', () => {
    const created = store.createSession({});
    saved(store.replaceSession(created.id, { revision: 1, stash: filledStash(), messages: [] }));

    const patched = saved(
      store.patchSession(created.id, { revision: 2, finishedAvatar: 'Elowen.png' }),
    );
    expect(patched.finishedAvatar).toBe('Elowen.png');
    expect(patched.stash.description?.text).toBe('Tall and tired.');
  });

  test('an absent avatar leaves it alone; an explicit null clears it', () => {
    const created = store.createSession({});
    const withAvatar = saved(store.patchSession(created.id, { revision: 1, avatar: 'a.png' }));
    expect(withAvatar.avatar).toBe('a.png');

    const renamed = saved(store.patchSession(created.id, { revision: 2, title: 'Still here' }));
    expect(renamed.avatar).toBe('a.png');

    const cleared = saved(store.patchSession(created.id, { revision: 3, avatar: null }));
    expect(cleared.avatar).toBeNull();
  });

  test('a patch bumps `modified`, so the session list reorders', () => {
    const created = store.createSession({});
    const patched = saved(store.patchSession(created.id, { revision: 1, title: 'Moved' }));

    expect(patched.modified).toBeGreaterThanOrEqual(created.modified);
  });
});

describe('the transcript', () => {
  test('a message whose `mes` disagrees with its swipe slot is repaired on write', () => {
    const created = store.createSession({});
    saved(
      store.replaceSession(created.id, {
        revision: 1,
        messages: [
          message({ id: 'm1', mes: 'What the reader saw.', swipes: ['stale'], swipe_id: 0 }),
        ],
      }),
    );

    const read = store.getSession(created.id)!;
    expect(read.messages[0]!.mes).toBe('What the reader saw.');
    expect(read.messages[0]!.swipes).toEqual(['What the reader saw.']);
    expect(read.messages[0]!.swipe_info).toHaveLength(1);
  });

  test('swipes and the selected index survive a round-trip', () => {
    const created = store.createSession({});
    saved(
      store.replaceSession(created.id, {
        revision: 1,
        messages: [
          message({
            id: 'm1',
            mes: 'Second.',
            swipes: ['First.', 'Second.', 'Third.'],
            swipe_id: 1,
            swipe_info: [
              { send_date: 'a' },
              { send_date: 'b', extra: { model: 'gpt-5.6-sol' } },
              { send_date: 'c' },
            ],
          }),
        ],
      }),
    );

    const read = store.getSession(created.id)!.messages[0]!;
    expect(read.swipes).toEqual(['First.', 'Second.', 'Third.']);
    expect(read.swipe_id).toBe(1);
    expect(read.swipe_info?.[1]?.extra?.model).toBe('gpt-5.6-sol');
  });

  test('message order is preserved by position, not insertion luck', () => {
    const created = store.createSession({});
    saved(
      store.replaceSession(created.id, {
        revision: 1,
        messages: [
          message({ id: 'a', mes: 'one', is_user: true }),
          message({ id: 'b', mes: 'two' }),
          message({ id: 'c', mes: 'three', is_user: true }),
        ],
      }),
    );

    const read = store.getSession(created.id)!;
    expect(read.messages.map((entry) => entry.mes)).toEqual(['one', 'two', 'three']);
    expect(read.messages.map((entry) => entry.is_user)).toEqual([true, false, true]);
  });
});

describe('listing and deleting', () => {
  test('sessions list newest-first with a preview of the current swipe', () => {
    const first = store.createSession({ title: 'Older' });
    saved(
      store.replaceSession(first.id, {
        revision: 1,
        messages: [message({ mes: 'Hi.' }), message({ mes: 'The lamp room is cold.' })],
      }),
    );
    const second = store.createSession({ title: 'Newer' });
    // Both writes land in the same millisecond, so pin `modified` rather than assert on a
    // tie SQLite is free to break either way.
    database.exec(`UPDATE cocreator_sessions SET modified = 100 WHERE id = '${first.id}'`);
    database.exec(`UPDATE cocreator_sessions SET modified = 200 WHERE id = '${second.id}'`);

    const list = store.listSessions();
    expect(list.map((entry) => entry.title)).toEqual(['Newer', 'Older']);
    const older = list.find((entry) => entry.title === 'Older')!;
    expect(older.messageCount).toBe(2);
    expect(older.lastMessage).toBe('The lamp room is cold.');
  });

  test('an empty session lists with a blank preview rather than null', () => {
    store.createSession({});

    expect(store.listSessions()[0]!.lastMessage).toBe('');
  });

  test('the badge counts filled slots, using the same rule the panel does', () => {
    const created = store.createSession({});
    saved(store.replaceSession(created.id, { revision: 1, stash: filledStash(), messages: [] }));

    // description + alternate_greetings + tags
    expect(store.listSessions()[0]!.stashedSlots).toBe(3);
  });

  test('deleting cascades the message rows', () => {
    const created = store.createSession({});
    saved(store.replaceSession(created.id, { revision: 1, messages: [message(), message()] }));
    expect(
      database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM cocreator_messages')
        .get()!.count,
    ).toBe(2);

    expect(store.deleteSession(created.id)).toBe(true);
    expect(store.getSession(created.id)).toBeNull();
    expect(
      database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM cocreator_messages')
        .get()!.count,
    ).toBe(0);
  });

  test('deleting an unknown session reports false', () => {
    expect(store.deleteSession('nope')).toBe(false);
  });
});

describe('repairing stored JSON', () => {
  test('a corrupt stash column reads as an empty stash rather than throwing', () => {
    const created = store.createSession({});
    database.exec(`UPDATE cocreator_sessions SET stash = 'not json' WHERE id = '${created.id}'`);

    expect(store.getSession(created.id)!.stash).toEqual(emptyStash());
  });

  test('example toggles default in, and unknown keys are dropped', () => {
    const selection = normalizeExamples({
      cards: ['a.png'],
      fields: { mes_example: true, bogus: true },
    });

    expect(selection.fields.mes_example).toBe(true);
    expect(selection.fields.description).toBe(true);
    expect('bogus' in selection.fields).toBe(false);
  });

  test('a duplicate example is attached once', () => {
    expect(normalizeExamples({ cards: ['a.png', 'a.png', 'b.png'] }).cards).toEqual([
      'a.png',
      'b.png',
    ]);
  });

  test('an absent session override stays absent, so it keeps following the app setting', () => {
    expect(normalizeSessionSettings({})).toEqual({});
    expect(normalizeSessionSettings({ connectionId: 42, presetId: 'p1' })).toEqual({
      presetId: 'p1',
    });
    // Null is a real value here — "follow the chat connection" — and must survive.
    expect(normalizeSessionSettings({ connectionId: null })).toEqual({ connectionId: null });
  });
});

describe('migration', () => {
  test('a v3 database gains both tables and is stamped 4', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY, character_id TEXT NOT NULL, title TEXT NOT NULL,
        created INTEGER NOT NULL, modified INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE messages (
        chat_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
        is_user INTEGER NOT NULL, is_system INTEGER NOT NULL, persona_id TEXT,
        swipe_id INTEGER NOT NULL DEFAULT 0, swipes TEXT NOT NULL, swipe_info TEXT NOT NULL,
        PRIMARY KEY (chat_id, id)
      ) WITHOUT ROWID;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '3');
      INSERT INTO chats VALUES ('c1', 'a.png', 'Kept chat', 1, 2, 5, '{}');
    `);

    createSchema(legacy);

    // The existing chat is untouched, and the new tables exist and work.
    expect(legacy.query<{ title: string }, []>('SELECT title FROM chats').get()!.title).toBe(
      'Kept chat',
    );
    const migrated = createCocreatorStore(legacy);
    expect(migrated.listSessions()).toEqual([]);
    expect(migrated.createSession({ title: 'First' }).title).toBe('First');
    expect(
      legacy
        .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
        .get('schema_version')?.value,
    ).toBe('4');
  });

  test('createSchema is idempotent — running it twice keeps the sessions', () => {
    const created = store.createSession({ title: 'Survivor' });

    createSchema(database);

    expect(store.getSession(created.id)?.title).toBe('Survivor');
  });
});
