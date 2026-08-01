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
import type {
  Chat,
  ChatMessage,
  ChatMetadata,
  ChatSummary,
  StaleChatRevision,
} from '../../shared/types/chat.ts';
import { getDb } from './db.ts';

interface ChatRow {
  id: string;
  character_id: string;
  title: string;
  created: number;
  modified: number;
  revision: number;
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
    chat: { revision: number; title?: string; metadata?: ChatMetadata; messages: ChatMessage[] },
  ): ChatSaveResult;
  updateChatMeta(
    id: string,
    updates: { revision: number; title?: string; metadata?: ChatMetadata },
  ): ChatSaveResult;
  deleteChat(id: string): boolean;
  /** Copy a chat up to and including a message, as a new chat. */
  branchChat(id: string, afterMessageId: string, title?: string): Chat | null;
}

export type ChatSaveResult =
  | { kind: 'saved'; chat: Chat }
  | { kind: 'notFound' }
  | { kind: 'stale'; conflict: StaleChatRevision };

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
      `INSERT INTO chats (id, character_id, title, created, modified, revision, metadata)
       VALUES ($id, $characterId, $title, $created, $modified, $revision, $metadata)`,
    ),
    selectChat: database.query<ChatRow, [string]>('SELECT * FROM chats WHERE id = ?'),
    replaceChat: database.query(
      `UPDATE chats
         SET title = $title, metadata = $metadata, modified = $modified, revision = $revision
       WHERE id = $id`,
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
      revision: row.revision,
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
      $revision: row.revision,
      $metadata: row.metadata,
    });
    writeMessages(row.id, messages);
  });

  function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => toChatMessage(fromChatMessage(message)));
  }

  function sameMessages(left: ChatMessage[], right: ChatMessage[]): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  const saveWholeChat = database.transaction(
    (
      id: string,
      input: { revision: number; title?: string; metadata?: ChatMetadata; messages: ChatMessage[] },
    ): ChatSaveResult => {
      const existing = readChat(id);
      if (!existing) return { kind: 'notFound' };

      const title = input.title?.trim() || existing.title;
      const metadata = input.metadata ?? existing.metadata;
      const messages = normalizeMessages(input.messages);

      if (input.revision < existing.revision) {
        return {
          kind: 'stale',
          conflict: { code: 'stale_revision', currentRevision: existing.revision },
        };
      }

      if (input.revision === existing.revision) {
        if (
          title === existing.title &&
          JSON.stringify(metadata) === JSON.stringify(existing.metadata) &&
          sameMessages(messages, existing.messages)
        ) {
          return { kind: 'saved', chat: existing };
        }
        return {
          kind: 'stale',
          conflict: { code: 'stale_revision', currentRevision: existing.revision },
        };
      }

      statements.replaceChat.run({
        $id: id,
        $title: title,
        $metadata: JSON.stringify(metadata),
        $modified: Date.now(),
        $revision: input.revision,
      });
      writeMessages(id, messages);
      return { kind: 'saved', chat: readChat(id)! };
    },
  );

  const saveMeta = database.transaction(
    (
      id: string,
      input: { revision: number; title?: string; metadata?: ChatMetadata },
    ): ChatSaveResult => {
      const existing = readChat(id);
      if (!existing) return { kind: 'notFound' };

      const title = input.title?.trim() || existing.title;
      const metadata = input.metadata ?? existing.metadata;
      if (input.revision < existing.revision) {
        return {
          kind: 'stale',
          conflict: { code: 'stale_revision', currentRevision: existing.revision },
        };
      }
      if (input.revision === existing.revision) {
        if (
          title === existing.title &&
          JSON.stringify(metadata) === JSON.stringify(existing.metadata)
        ) {
          return { kind: 'saved', chat: existing };
        }
        return {
          kind: 'stale',
          conflict: { code: 'stale_revision', currentRevision: existing.revision },
        };
      }

      statements.replaceChat.run({
        $id: id,
        $title: title,
        $metadata: JSON.stringify(metadata),
        $modified: Date.now(),
        $revision: input.revision,
      });
      return { kind: 'saved', chat: readChat(id)! };
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
          revision: 0,
          metadata: JSON.stringify(input.metadata ?? {}),
        },
        input.messages ?? [],
      );

      return readChat(id)!;
    },

    replaceChat(id, chat): ChatSaveResult {
      return saveWholeChat(id, chat);
    },

    updateChatMeta(id, updates): ChatSaveResult {
      return saveMeta(id, updates);
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
          revision: 0,
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
