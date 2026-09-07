/**
 * Chat storage.
 *
 * Every message crossing this boundary — in either direction — goes through
 * shared/chat/message.ts, so a message whose `mes` disagrees with its selected swipe is
 * repaired rather than persisted. The client cannot write an inconsistent row even if it
 * tries, and neither can a future caller who forgets the rule.
 */

import type { Database } from 'bun:sqlite';
import { remapBranchMetadata } from '../../shared/chat/branch.ts';
import { fromChatMessage, normalizeState, toChatMessage } from '../../shared/chat/message.ts';
import type {
  BranchOrigin,
  Chat,
  ChatMessage,
  ChatMetadata,
  ChatSummary,
  StaleChatRevision,
} from '../../shared/types/chat.ts';
import { writeChatBackup } from './backups.ts';
import { getDb } from './db.ts';
import { migrateNexusLibrary } from './nexus.ts';
import { PATHS } from './paths.ts';
import { getSettings } from './settings.ts';

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
  hidden_by: string | null;
  /** Null: speaker not recorded (legacy). Empty string: explicitly no persona. */
  persona_id: string | null;
  swipe_id: number;
  swipes: string;
  swipe_info: string;
}

export interface ChatStore {
  listChats(characterId?: string): ChatSummary[];
  listRecent(limit: number): ChatSummary[];
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
  /**
   * Delete one chat. Backed up first, so a misclick on the trash is recoverable — and a
   * backup failure aborts the delete instead of destroying the transcript unrecorded.
   */
  deleteChat(id: string): boolean;
  /** Copy a chat up to and including a message, as a new chat. */
  branchChat(id: string, afterMessageId: string, title?: string): Chat | null;
  /**
   * Move every chat from one character identity to another, for a character rename.
   * The filename IS the identity, so renaming a character changes the id its chats key on;
   * without this the transcripts are orphaned from the renamed card. Returns the count moved.
   */
  reassignCharacter(oldCharacterId: string, newCharacterId: string): number;
  /**
   * Delete every chat belonging to a character, for a character deletion. Each chat is
   * backed up first — the character's file delete is rolled back if a backup fails, so a
   * card cannot be destroyed without a restorable copy of its transcripts. Returns the count.
   */
  deleteChatsForCharacter(characterId: string): number;
}

/**
 * Where deleted chats are backed up before their rows go.
 * `null` disables the backup (tests); undefined uses the default directory.
 */
export interface ChatStoreOptions {
  backupDir?: string | null;
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
      hiddenBy: row.hidden_by ?? undefined,
      // The column's NULL means "not recorded"; normalizeState maps the empty string
      // to the explicit no-persona, so the row's three states land intact.
      persona_id: row.persona_id ?? undefined,
      swipes: parseJson<string[]>(row.swipes, ['']),
      swipe_id: row.swipe_id,
      swipe_info: parseJson(row.swipe_info, []),
    }),
  );
}

export function createChatStore(database: Database, options: ChatStoreOptions = {}): ChatStore {
  // undefined means the default directory; null means no backups at all (tests).
  const backupDir = options.backupDir === undefined ? PATHS.backups : options.backupDir;

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
    reassignCharacter: database.query(
      'UPDATE chats SET character_id = $new WHERE character_id = $old',
    ),
    countChatsForCharacter: database.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM chats WHERE character_id = ?',
    ),
    chatIdsForCharacter: database.query<{ id: string }, [string]>(
      'SELECT id FROM chats WHERE character_id = ?',
    ),
    deleteChatsForCharacter: database.query('DELETE FROM chats WHERE character_id = ?'),

    selectMessages: database.query<MessageRow, [string]>(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY position ASC',
    ),
    deleteMessages: database.query('DELETE FROM messages WHERE chat_id = ?'),
    insertMessage: database.query(
      `INSERT INTO messages
         (chat_id, id, position, name, is_user, is_system, hidden_by, persona_id, swipe_id, swipes, swipe_info)
       VALUES ($chatId, $id, $position, $name, $isUser, $isSystem, $hiddenBy, $personaId, $swipeId, $swipes, $swipeInfo)`,
    ),
  };

  // The current swipe's text as the preview, taken live rather than denormalised into a
  // column that could disagree with the message it summarises. `branchedFrom` arrives as
  // JSON text (json_extract of an object), parsed on the way out below.
  const summarySelect = `
    SELECT c.id, c.character_id AS characterId, c.title, c.created, c.modified,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messageCount,
      (SELECT substr(json_extract(m.swipes, '$[' || m.swipe_id || ']'), 1, 200)
         FROM messages m WHERE m.chat_id = c.id
        ORDER BY m.position DESC LIMIT 1) AS lastMessage,
      json_extract(c.metadata, '$.branchedFrom') AS branchedFrom
    FROM chats c`;

  interface SummaryRow extends Omit<ChatSummary, 'branchedFrom'> {
    branchedFrom: string | null;
  }

  function rowToSummary(row: SummaryRow): ChatSummary {
    const origin =
      row.branchedFrom === null
        ? undefined
        : parseJson<BranchOrigin | null>(row.branchedFrom, null);
    // A malformed blob is not a summary-killer; the chat lists without its provenance.
    return {
      ...row,
      lastMessage: row.lastMessage ?? '',
      branchedFrom: origin ?? undefined,
    };
  }

  const listAll = database.query<SummaryRow, []>(`${summarySelect} ORDER BY c.modified DESC`);
  const listRecent = database.query<SummaryRow, [number]>(
    `${summarySelect} ORDER BY c.modified DESC LIMIT ?`,
  );
  const listForCharacter = database.query<SummaryRow, [string]>(
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
        $hiddenBy: state.hiddenBy ?? null,
        // NULL is reserved for "speaker not recorded"; the explicit no-persona stores
        // as an empty string so a legacy row and a persona-less message stay distinct.
        $personaId: state.persona_id === undefined ? null : (state.persona_id ?? ''),
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
      return rows.map(rowToSummary);
    },

    listRecent(limit: number): ChatSummary[] {
      return listRecent.all(limit).map(rowToSummary);
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
      const existing = readChat(id);
      if (!existing) return false;
      // The backup is the only way back after this. Write it before the rows go, and let
      // a failure abort the delete rather than destroy the transcript unrecorded.
      if (backupDir) writeChatBackup(existing, backupDir);
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

      // Fresh ids: the copies are independent messages from here on. Every metadata
      // reference to a message id (memory ranges, the memory watermark, the summary
      // checkpoint) is remapped onto them, or the branch would carry ranges that can
      // never resolve against its own transcript.
      const idMap = new Map<string, string>();
      const copied = source.messages.slice(0, cut + 1).map((message) => {
        const id = crypto.randomUUID();
        idMap.set(message.id, id);
        return { ...message, id };
      });

      insertWithMessages(
        {
          id: branchId,
          character_id: source.characterId,
          title: title?.trim() || `${source.title} (branch)`,
          created: now,
          modified: now,
          revision: 0,
          metadata: JSON.stringify({
            ...remapBranchMetadata(source.metadata, source.messages, idMap),
            branchedFrom: {
              chatId: source.id,
              messageId: afterMessageId,
            },
          }),
        },
        copied,
      );

      return readChat(branchId);
    },

    reassignCharacter(oldCharacterId, newCharacterId): number {
      if (oldCharacterId === newCharacterId) return 0;
      return statements.reassignCharacter.run({
        $old: oldCharacterId,
        $new: newCharacterId,
      }).changes;
    },

    deleteChatsForCharacter(characterId): number {
      // Count first: the DELETE's `.changes` also counts the message rows removed by
      // ON DELETE CASCADE, so it would overstate how many CHATS went. Messages follow.
      const count = statements.countChatsForCharacter.get(characterId)?.count ?? 0;
      if (count === 0) return 0;
      // Back up every chat before any row goes, so a failure (which aborts the whole
      // character delete through the tombstone rollback) leaves nothing half-removed.
      if (backupDir) {
        for (const row of statements.chatIdsForCharacter.all(characterId)) {
          const chat = readChat(row.id);
          if (chat) writeChatBackup(chat, backupDir);
        }
      }
      statements.deleteChatsForCharacter.run(characterId);
      return count;
    },
  };
}

let store: ChatStore | null = null;

/** The application chat store. Tests build their own against an in-memory database. */
export function chatStore(): ChatStore {
  if (!store) {
    const next = createChatStore(getDb());
    migrateNexusLibrary(getDb(), next, getSettings().memoryMode);
    store = next;
  }
  return store;
}

/**
 * Drop the memoized store, so the next call rebuilds it against the current data directory.
 *
 * It holds prepared statements bound to one connection and a backup directory captured at
 * construction, so it has to go before the database closes — not after.
 */
export function resetChatStore(): void {
  store = null;
}
