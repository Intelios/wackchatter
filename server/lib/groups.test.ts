import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { emptyGroup } from '../../shared/types/group.ts';
import { createChatStore } from './chats.ts';
import { createSchema } from './db.ts';
import { createGroupStore } from './groups.ts';

const config = () => ({
  ...emptyGroup(),
  members: ['a', 'b'].map((id) => ({
    id,
    characterId: `${id}.png`,
    name: id,
    publicProfile: '',
    muted: false,
  })),
});

test('group snapshots, independent branches, deletion and speaker persistence', () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createSchema(db);
  const groups = createGroupStore(db);
  const chats = createChatStore(db, { backupDir: null });
  const group = groups.create(config());
  const chat = chats.createChat({
    kind: 'group',
    metadata: { group: { ...group, templateId: group.id } },
    messages: [
      {
        id: 'm',
        name: 'a',
        memberId: 'a',
        characterId: 'a.png',
        mes: 'Hi',
        send_date: 'now',
        is_user: false,
        is_system: false,
      },
    ],
  });
  expect(chat.characterId).toBeNull();
  expect(chat.kind).toBe('group');
  expect(chats.getChat(chat.id)?.messages[0]?.memberId).toBe('a');
  expect(groups.save(group.id, 0, { ...config(), name: 'Changed' })?.revision).toBe(1);
  expect(groups.save(group.id, 0, config())).toBeNull();
  expect(chats.getChat(chat.id)?.metadata.group?.name).toBe('New group');
  const branch = chats.branchChat(chat.id, 'm')!;
  expect(branch.kind).toBe('group');
  expect(branch.messages[0]?.id).not.toBe('m');
  expect(branch.messages[0]?.memberId).toBe('a');
  chats.reassignCharacter('a.png', 'renamed.png');
  expect(chats.getChat(chat.id)?.metadata.group?.members[0]?.characterId).toBe('renamed.png');
  expect(chats.getChat(chat.id)?.messages[0]?.characterId).toBe('renamed.png');
  expect(groups.get(group.id)?.members[0]?.characterId).toBe('renamed.png');
  chats.deleteChatsForCharacter('renamed.png');
  groups.remove(group.id);
  expect(chats.getChat(chat.id)).not.toBeNull();
  expect(chats.listRecent(2).every((c) => c.kind === 'group')).toBe(true);
  db.close();
});

test('schema upgrade keeps direct chats and child rows with foreign keys intact', () => {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE chats(id TEXT PRIMARY KEY, character_id TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, modified INTEGER NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL);
    INSERT INTO chats VALUES ('old', 'a.png', 'Old', 1, 1, 0, '{}');`);
  createSchema(db);
  const chats = createChatStore(db, { backupDir: null });
  expect(chats.getChat('old')?.kind).toBe('direct');
  const g = chats.createChat({ kind: 'group', metadata: { group: config() } });
  expect(g.characterId).toBeNull();
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  db.close();
});
