/**
 * Chat storage.
 *
 * Every message crossing this boundary — in either direction — goes through
 * shared/chat/message.ts, so a message whose `mes` disagrees with its selected swipe is
 * repaired rather than persisted. The client cannot write an inconsistent row even if it
 * tries, and neither can a future caller who forgets the rule.
 */

import type { Database } from 'bun:sqlite';
import { fromChatMessage, normalizeState, toChatMessage } from '../../shared/chat/message.ts';
import type { Chat, ChatMessage, ChatMetadata, ChatSummary } from '../../shared/types/chat.ts';
import { getDb } from './db.ts';

interface ChatRow {
  id: string;
  character_id: string;
  title: string;
  created: number;
  modified: number;
  metadata: string;
}

interface MessageRow {
  id: string;
  position: number;
  name: string;
  is_user: number;
  is_system: number;
  swipe_id: number;
  swipes: string;
  swipe_info: string;
}

export interface ChatStore {
  listChats(characterId?: string): ChatSummary[];
  getChat(id: string): Chat | null;
  createChat(input: {
    characterId: string;
    title?: string;
    metadata?: ChatMetadata;
    messages?: ChatMessage[];
  }): Chat;
  /** Whole-chat write: the only path that changes messages. */
  replaceChat(
    id: string,
    chat: { title?: string; metadata?: ChatMetadata; messages: ChatMessage[] },
  ): Chat | null;
  updateChatMeta(id: string, updates: { title?: string; metadata?: ChatMetadata }): Chat | null;
  deleteChat(id: string): boolean;
  /** Copy a chat up to and including a message, as a new chat. */
  branchChat(id: string, afterMessageId: string, title?: string): Chat | null;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToMessage(row: MessageRow): ChatMessage {
  // A row already holds exactly MessageState's fields, so it is normalised directly
  // rather than being squeezed through ChatMessage — there is no `mes` to invent, and
  // therefore nothing that could overwrite the metadata the row actually stores.
  return toChatMessage(
    normalizeState({
      id: row.id,
      name: row.name,
      is_user: row.is_user === 1,
      is_system: row.is_system === 1,
      swipes: parseJson<string[]>(row.swipes, ['']),
      swipe_id: row.swipe_id,
      swipe_info: parseJson(row.swipe_info, []),
    }),
  );
}

export function createChatStore(database: Database): ChatStore {
  const statements = {
    insertChat: database.query(
      `INSERT INTO chats (id, character_id, title, created, modified, metadata)
       VALUES ($id, $characterId, $title, $created, $modified, $metadata)`,
    ),
    selectChat: database.query<ChatRow, [string]>('SELECT * FROM chats WHERE id = ?'),
    touchChat: database.query('UPDATE chats SET modified = $modified WHERE id = $id'),
    updateMeta: database.query(
      'UPDATE chats SET title = $title, metadata = $metadata, modified = $modified WHERE id = $id',
    ),
    deleteChat: database.query('DELETE FROM chats WHERE id = ?'),

    selectMessages: database.query<MessageRow, [string]>(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY position ASC',
    ),
    deleteMessages: database.query('DELETE FROM messages WHERE chat_id = ?'),
    insertMessage: database.query(
      `INSERT INTO messages
         (chat_id, id, position, name, is_user, is_system, swipe_id, swipes, swipe_info)
       VALUES ($chatId, $id, $position, $name, $isUser, $isSystem, $swipeId, $swipes, $swipeInfo)`,
    ),
  };

  // The current swipe's text as the preview, taken live rather than denormalised into a
  // column that could disagree with the message it summarises.
  const summarySelect = `
    SELECT c.id, c.character_id AS characterId, c.title, c.created, c.modified,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messageCount,
      (SELECT substr(json_extract(m.swipes, '$[' || m.swipe_id || ']'), 1, 200)
         FROM messages m WHERE m.chat_id = c.id
        ORDER BY m.position DESC LIMIT 1) AS lastMessage
    FROM chats c`;

  const listAll = database.query<ChatSummary, []>(`${summarySelect} ORDER BY c.modified DESC`);
  const listForCharacter = database.query<ChatSummary, [string]>(
    `${summarySelect} WHERE c.character_id = ? ORDER BY c.modified DESC`,
  );

  function writeMessages(chatId: string, messages: ChatMessage[]): void {
    statements.deleteMessages.run(chatId);

    messages.forEach((message, position) => {
      // Repair on the way in, so the row can only ever hold a consistent message.
      const state = fromChatMessage(message);
      statements.insertMessage.run({
        $chatId: chatId,
        $id: state.id,
        $position: position,
        $name: state.name,
        $isUser: state.is_user ? 1 : 0,
        $isSystem: state.is_system ? 1 : 0,
        $swipeId: state.swipe_id,
        $swipes: JSON.stringify(state.swipes),
        $swipeInfo: JSON.stringify(state.swipe_info),
      });
    });
  }

  function readChat(id: string): Chat | null {
    const row = statements.selectChat.get(id);
    if (!row) return null;

    return {
      id: row.id,
      characterId: row.character_id,
      title: row.title,
      created: row.created,
      modified: row.modified,
      metadata: parseJson<ChatMetadata>(row.metadata, {}),
      messages: statements.selectMessages.all(id).map(rowToMessage),
    };
  }

  const insertWithMessages = database.transaction((row: ChatRow, messages: ChatMessage[]): void => {
    statements.insertChat.run({
      $id: row.id,
      $characterId: row.character_id,
      $title: row.title,
      $created: row.created,
      $modified: row.modified,
      $metadata: row.metadata,
    });
    writeMessages(row.id, messages);
  });

  const replaceMessages = database.transaction(
    (id: string, messages: ChatMessage[], modified: number): void => {
      writeMessages(id, messages);
      statements.touchChat.run({ $id: id, $modified: modified });
    },
  );

  return {
    listChats(characterId?: string): ChatSummary[] {
      const rows = characterId ? listForCharacter.all(characterId) : listAll.all();
      // json_extract returns null for an empty chat; ChatSummary promises a string.
      return rows.map((row) => ({ ...row, lastMessage: row.lastMessage ?? '' }));
    },

    getChat: readChat,

    createChat(input): Chat {
      const now = Date.now();
      const id = crypto.randomUUID();

      insertWithMessages(
        {
          id,
          character_id: input.characterId,
          title: input.title?.trim() || 'New chat',
          created: now,
          modified: now,
          metadata: JSON.stringify(input.metadata ?? {}),
        },
        input.messages ?? [],
      );

      return readChat(id)!;
    },

    replaceChat(id, chat): Chat | null {
      const existing = statements.selectChat.get(id);
      if (!existing) return null;

      const now = Date.now();
      if (chat.title !== undefined || chat.metadata !== undefined) {
        statements.updateMeta.run({
          $id: id,
          $title: chat.title ?? existing.title,
          $metadata: JSON.stringify(
            chat.metadata ?? parseJson<ChatMetadata>(existing.metadata, {}),
          ),
          $modified: now,
        });
      }

      replaceMessages(id, chat.messages, now);
      return readChat(id);
    },

    updateChatMeta(id, updates): Chat | null {
      const existing = statements.selectChat.get(id);
      if (!existing) return null;

      statements.updateMeta.run({
        $id: id,
        $title: updates.title?.trim() || existing.title,
        $metadata: JSON.stringify(
          updates.metadata ?? parseJson<ChatMetadata>(existing.metadata, {}),
        ),
        $modified: Date.now(),
      });

      return readChat(id);
    },

    deleteChat(id): boolean {
      // Messages go with it via ON DELETE CASCADE — which only fires because
      // openDatabase sets foreign_keys on the connection.
      return statements.deleteChat.run(id).changes > 0;
    },

    branchChat(id, afterMessageId, title): Chat | null {
      const source = readChat(id);
      if (!source) return null;

      const cut = source.messages.findIndex((message) => message.id === afterMessageId);
      if (cut === -1) return null;

      const now = Date.now();
      const branchId = crypto.randomUUID();

      insertWithMessages(
        {
          id: branchId,
          character_id: source.characterId,
          title: title?.trim() || `${source.title} (branch)`,
          created: now,
          modified: now,
          metadata: JSON.stringify(source.metadata),
        },
        // Fresh ids: the copies are independent messages from here on.
        source.messages
          .slice(0, cut + 1)
          .map((message) => ({
            ...message,
            id: crypto.randomUUID(),
          })),
      );

      return readChat(branchId);
    },
  };
}

let store: ChatStore | null = null;

/** The application chat store. Tests build their own against an in-memory database. */
export function chatStore(): ChatStore {
  store ??= createChatStore(getDb());
  return store;
}
