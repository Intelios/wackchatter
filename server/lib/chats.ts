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
import {
  fromChatMessage,
  type MessageState,
  normalizeState,
  toChatMessage,
} from '../../shared/chat/message.ts';
import type {
  BranchOrigin,
  Chat,
  ChatMessage,
  ChatMetadata,
  ChatSaveAck,
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
  character_id: string | null;
  title: string;
  created: number;
  modified: number;
  revision: number;
  /** Idempotency token of the incremental save that wrote this revision; see db.ts. */
  save_token: string | null;
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

/**
 * A chat's metadata without its transcript, which is all a library-wide pass needs. The
 * summary query is deliberately not reused here: it exists to render a recents list, and
 * its per-chat preview subqueries would be paid for on every chat to deliver nothing.
 */
export interface ChatMeta {
  id: string;
  revision: number;
  metadata: ChatMetadata;
}

export interface ChatStore {
  listChats(characterId?: string): ChatSummary[];
  listRecent(limit: number): ChatSummary[];
  listChatMetas(): ChatMeta[];
  getChat(id: string): Chat | null;
  createChat(input: {
    characterId: string;
    title?: string;
    metadata?: ChatMetadata;
    messages?: ChatMessage[];
  }): Chat;
  /**
   * Whole-chat replace. The write path of the whole-document semantics: revision-gated,
   * content-compared at equal revisions, and the returned chat re-read after the write.
   * The route saves through `saveChat` instead; this remains for callers that already
   * hold a full transcript.
   */
  replaceChat(
    id: string,
    chat: { revision: number; title?: string; metadata?: ChatMetadata; messages: ChatMessage[] },
  ): ChatSaveResult;
  /**
   * The incremental write — the path every queued save takes.
   *
   * Applies `input` only while the row's revision still equals `input.baseRevision`
   * (compare-and-swap), and acknowledges an exact redelivery of the same save via
   * `input.saveId` instead of writing twice. `order` is the complete post-save
   * transcript order: rows it omits are deleted, and only `upsert` messages are
   * inserted or rewritten — everything else moves by position update alone.
   */
  saveChat(id: string, input: ChatSaveInput): ChatSaveAckResult;
  /** Title/metadata-only write; never reads or touches message rows. */
  updateChatMeta(
    id: string,
    updates: { revision: number; title?: string; metadata?: ChatMetadata },
  ): ChatSaveAckResult;
  /**
   * Migration door: replace a chat's metadata and bump its revision, without restamping
   * `modified` and without reading the transcript. Returns null for an unknown chat.
   *
   * Deliberately not a general-purpose save. A library-wide repair is not the user
   * touching every chat, so recency — and with it the recents list, the character picker
   * and every "last spoke" figure — has to survive the pass untouched. The revision does
   * move, so a client holding a pre-migration snapshot cannot write it back.
   */
  migrateChatMeta(id: string, metadata: ChatMetadata): ChatMeta | null;
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

/** The small acknowledgement — saves never echo the transcript back. */
export type ChatSaveAckResult =
  | { kind: 'saved'; ack: ChatSaveAck }
  | { kind: 'notFound' }
  | { kind: 'stale'; conflict: StaleChatRevision };

/**
 * One incremental save.
 *
 * `order` plus `upsert` describe the transcript delta: `order` is every message id in
 * position order, `upsert` only the rows to insert or rewrite. When both are absent the
 * save touches the head fields only — which is also what an unchanged transcript looks
 * like, the client never sending an order it could have omitted.
 */
export interface ChatSaveInput {
  revision: number;
  /** Idempotency token minted by the client per save unit. */
  saveId: string;
  /** The server revision this save is computed against. */
  baseRevision: number;
  title?: string;
  metadata?: ChatMetadata;
  order?: string[];
  upsert?: ChatMessage[];
}

/** Thrown inside the save transaction when the delta cannot describe the write. */
class DeltaConflict extends Error {
  constructor(readonly revision: number) {
    super('Save cannot be applied against this revision.');
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Stored metadata, always a plain object.
 *
 * `parseJson` alone is not enough: a row holding the JSON literal `null` parses
 * successfully, so the fallback never fires and callers get a `ChatMetadata` that is not
 * one — every `metadata.<field>` read then throws. The repair belongs here rather than at
 * each call site, because a caller cannot defend against a type that lies.
 */
function parseMetadata(raw: string): ChatMetadata {
  const parsed = parseJson<unknown>(raw, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as ChatMetadata)
    : {};
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
    // `kind = 'direct'` is on every read: group scenes were removed in 3.0, and the rows a
    // 2.x library still holds stay on disk untouched but invisible.
    selectChat: database.query<ChatRow, [string]>(
      "SELECT * FROM chats WHERE id = ? AND kind = 'direct'",
    ),
    // Metadata and revision only. A library-wide pass must not pay for transcripts it will
    // not read, and must not be slowed by the newest chat being the largest.
    selectChatMetas: database.query<{ id: string; revision: number; metadata: string }, []>(
      "SELECT id, revision, metadata FROM chats WHERE kind = 'direct'",
    ),
    replaceChat: database.query(
      `UPDATE chats
         SET title = $title, metadata = $metadata, modified = $modified, revision = $revision,
             save_token = NULL
       WHERE id = $id`,
    ),
    saveChat: database.query(
      `UPDATE chats
         SET title = $title, metadata = $metadata, modified = $modified, revision = $revision,
             save_token = $saveToken
       WHERE id = $id`,
    ),
    // Note the absent $modified: this is the migration door, and leaving recency alone is
    // the entire point of it. See migrateChatMeta.
    migrateChatMeta: database.query(
      `UPDATE chats SET metadata = $metadata, revision = $revision, save_token = NULL
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
    // Ids only, in position order — all an incremental save needs of the stored
    // transcript to compute which rows move, go or stay.
    selectMessageIds: database.query<{ id: string }, [string]>(
      'SELECT id FROM messages WHERE chat_id = ? ORDER BY position ASC',
    ),
    deleteMessages: database.query('DELETE FROM messages WHERE chat_id = ?'),
    // Every message row whose id is NOT in the $order JSON array — including all of them
    // when the array is empty.
    deleteNotInOrder: database.query(
      'DELETE FROM messages WHERE chat_id = $chatId AND id NOT IN (SELECT value FROM json_each($order))',
    ),
    insertMessage: database.query(
      `INSERT INTO messages
         (chat_id, id, position, name, is_user, is_system, hidden_by, persona_id, swipe_id, swipes, swipe_info)
       VALUES ($chatId, $id, $position, $name, $isUser, $isSystem, $hiddenBy, $personaId, $swipeId, $swipes, $swipeInfo)`,
    ),
    upsertMessage: database.query(
      `INSERT INTO messages
         (chat_id, id, position, name, is_user, is_system, hidden_by, persona_id, swipe_id, swipes, swipe_info)
       VALUES ($chatId, $id, $position, $name, $isUser, $isSystem, $hiddenBy, $personaId, $swipeId, $swipes, $swipeInfo)
       ON CONFLICT(chat_id, id) DO UPDATE SET
         position = excluded.position,
         name = excluded.name,
         is_user = excluded.is_user,
         is_system = excluded.is_system,
         hidden_by = excluded.hidden_by,
         persona_id = excluded.persona_id,
         swipe_id = excluded.swipe_id,
         swipes = excluded.swipes,
         swipe_info = excluded.swipe_info`,
    ),
    /*
     * Reordering on a UNIQUE(chat_id, position) index cannot be done in place: moving a
     * row onto a position another row still holds would collide. Shifted rows park at
     * -1 - desired (a disjoint negative range), then settle once inserts have claimed
     * their finals. The FROM join over json_each keeps both passes to one statement.
     */
    shiftToScratch: database.query(
      `UPDATE messages SET position = -1 - CAST(o.key AS INTEGER)
         FROM (SELECT key, value FROM json_each($order)) AS o
        WHERE chat_id = $chatId AND messages.id = o.value
          AND position != CAST(o.key AS INTEGER)`,
    ),
    settleScratch: database.query(
      `UPDATE messages SET position = CAST(o.key AS INTEGER)
         FROM (SELECT key, value FROM json_each($order)) AS o
        WHERE chat_id = $chatId AND messages.id = o.value
          AND position < 0`,
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
    FROM chats c
    WHERE c.kind = 'direct'`;

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
    `${summarySelect} AND c.character_id = ? ORDER BY c.modified DESC`,
  );

  function messageInsertParams(chatId: string, state: MessageState, position: number) {
    return {
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
    };
  }

  function writeMessages(chatId: string, messages: ChatMessage[]): void {
    statements.deleteMessages.run(chatId);

    messages.forEach((message, position) => {
      // Repair on the way in, so the row can only ever hold a consistent message.
      statements.insertMessage.run(messageInsertParams(chatId, fromChatMessage(message), position));
    });
  }

  function readChat(id: string): Chat | null {
    const row = statements.selectChat.get(id);
    if (!row) return null;

    return {
      id: row.id,
      // Never null on a direct chat; the column is nullable only for the removed scenes.
      characterId: row.character_id ?? '',
      title: row.title,
      created: row.created,
      modified: row.modified,
      revision: row.revision,
      metadata: parseMetadata(row.metadata),
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

  /*
   * The incremental write. Reads only the head row plus the stored id order — never the
   * transcript — and writes only what the delta names: unlisted ids deleted, upserted
   * messages inserted or rewritten, everything else moved by position update alone.
   *
   * Idempotency and conflict detection are one column pair, (revision, save_token):
   * an exact redelivery of the save that already landed acknowledges instead of
   * rewriting or conflicting, while a different save at the same revision, a newer
   * revision already recorded, or a base that is not the row's revision all report
   * stale. Revisions never move backwards.
   */
  const saveChatTx = database.transaction((id: string, input: ChatSaveInput): ChatSaveAckResult => {
    const row = statements.selectChat.get(id);
    if (!row) return { kind: 'notFound' };

    if (input.revision === row.revision) {
      return row.save_token !== null && row.save_token === input.saveId
        ? { kind: 'saved', ack: { revision: row.revision, modified: row.modified } }
        : {
            kind: 'stale',
            conflict: { code: 'stale_revision', currentRevision: row.revision },
          };
    }
    if (input.revision < row.revision || input.baseRevision !== row.revision) {
      return {
        kind: 'stale',
        conflict: { code: 'stale_revision', currentRevision: row.revision },
      };
    }

    const title = input.title?.trim() || row.title;
    const metadata = input.metadata ?? parseMetadata(row.metadata);

    if (input.order) {
      const existing = statements.selectMessageIds.all(id).map((r) => r.id);
      const existingIds = new Set(existing);
      const upsertIds = new Set((input.upsert ?? []).map((message) => message.id));

      // Every id the client claims its new order needs must either already be a row
      // or arrive in upsert. Anything else means the delta was computed against a
      // transcript this server does not hold — a base lie, not a write to guess at.
      for (const orderId of input.order) {
        if (!existingIds.has(orderId) && !upsertIds.has(orderId)) {
          throw new DeltaConflict(row.revision);
        }
      }

      const orderJson = JSON.stringify(input.order);
      // Park every row whose position changes before any upsert writes its target,
      // so an insert never collides with a row still holding that slot. See the
      // statement's comment for why two passes are needed at all.
      statements.shiftToScratch.run({ $chatId: id, $order: orderJson });
      statements.deleteNotInOrder.run({ $chatId: id, $order: orderJson });

      const positions = new Map(input.order.map((orderId, index) => [orderId, index]));
      for (const message of input.upsert ?? []) {
        const position = positions.get(message.id);
        if (position === undefined) {
          // Route validation is supposed to refuse this; refuse loudly rather than
          // orphan the row outside the declared order.
          throw new DeltaConflict(row.revision);
        }
        statements.upsertMessage.run(messageInsertParams(id, fromChatMessage(message), position));
      }
      statements.settleScratch.run({ $chatId: id, $order: orderJson });
    }

    const modified = Date.now();
    statements.saveChat.run({
      $id: id,
      $title: title,
      $metadata: JSON.stringify(metadata),
      $modified: modified,
      $revision: input.revision,
      $saveToken: input.saveId,
    });
    return { kind: 'saved', ack: { revision: input.revision, modified } };
  });

  const saveMeta = database.transaction(
    (
      id: string,
      input: { revision: number; title?: string; metadata?: ChatMetadata },
    ): ChatSaveAckResult => {
      // The head row alone: a metadata write has no business paying for a transcript it
      // never touches, which on a long chat is where the old readChat went.
      const row = statements.selectChat.get(id);
      if (!row) return { kind: 'notFound' };

      const title = input.title?.trim() || row.title;
      const metadata = input.metadata ?? parseMetadata(row.metadata);
      if (input.revision < row.revision) {
        return {
          kind: 'stale',
          conflict: { code: 'stale_revision', currentRevision: row.revision },
        };
      }
      if (input.revision === row.revision) {
        // Canonical-versus-canonical: the column text may not have been written by us,
        // so key order and whitespace cannot take part in "same document".
        if (
          title === row.title &&
          JSON.stringify(metadata) === JSON.stringify(parseMetadata(row.metadata))
        ) {
          return { kind: 'saved', ack: { revision: row.revision, modified: row.modified } };
        }
        return {
          kind: 'stale',
          conflict: { code: 'stale_revision', currentRevision: row.revision },
        };
      }

      const modified = Date.now();
      statements.replaceChat.run({
        $id: id,
        $title: title,
        $metadata: JSON.stringify(metadata),
        $modified: modified,
        $revision: input.revision,
      });
      return { kind: 'saved', ack: { revision: input.revision, modified } };
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

    listChatMetas(): ChatMeta[] {
      return statements.selectChatMetas.all().map((row) => ({
        id: row.id,
        revision: row.revision,
        metadata: parseMetadata(row.metadata),
      }));
    },

    getChat: readChat,

    createChat(input): Chat {
      if (!input.characterId) throw new Error('A chat needs a character.');
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
          save_token: null,
          metadata: JSON.stringify(input.metadata ?? {}),
        },
        input.messages ?? [],
      );

      return readChat(id)!;
    },

    replaceChat(id, chat): ChatSaveResult {
      return saveWholeChat(id, chat);
    },

    saveChat(id, input): ChatSaveAckResult {
      try {
        return saveChatTx(id, input);
      } catch (error) {
        if (error instanceof DeltaConflict) {
          return {
            kind: 'stale',
            conflict: { code: 'stale_revision', currentRevision: error.revision },
          };
        }
        throw error;
      }
    },

    updateChatMeta(id, updates): ChatSaveAckResult {
      return saveMeta(id, updates);
    },

    migrateChatMeta(id, metadata): ChatMeta | null {
      const existing = statements.selectChat.get(id);
      if (!existing) return null;
      const revision = existing.revision + 1;
      statements.migrateChatMeta.run({
        $id: id,
        $metadata: JSON.stringify(metadata),
        // Bumped so a stale client snapshot cannot overwrite migrated metadata, but a
        // revision is not recency: the timestamp column is what orders the library, and
        // this leaves it exactly as the user left it.
        $revision: revision,
      });
      return { id, revision, metadata };
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
          save_token: null,
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
      return statements.reassignCharacter.run({ $old: oldCharacterId, $new: newCharacterId })
        .changes;
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
