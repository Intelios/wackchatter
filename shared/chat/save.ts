/**
 * Incremental chat saves: the contract between the client's save queue and the store.
 *
 * A full save used to upload every message, delete every row and insert them all again,
 * then return the whole chat — three history-sized passes for a one-line edit. Instead
 * the queue ships a small delta:
 *
 *  - `states` on the record are the reducer's own immutable `MessageState` objects, so
 *    the body is built by reference comparison against the last acknowledged base — no
 *    serialising, no hashing. `buildChatSaveBody` emits the full order (ids only) plus
 *    just the changed messages.
 *  - `baseRevision` is a compare-and-swap on the server row's revision: the delta means
 *    "this transcript minus that one", so it may only apply while the server still holds
 *    that one. A mismatch answers 409 and the queue retries once with a full body.
 *  - `saveId` makes a redelivered save idempotent without comparing content: a pagehide
 *    keepalive and a normal flush can carry the same record, and the second one through
 *    acknowledges instead of conflicting or duplicating the write.
 *
 * Title and metadata diff by object identity too: the reducer replaces them wholesale on
 * every change, so a shared reference is a proof of "unchanged", and a full save always
 * carries them.
 */

import type { ChatMessage, ChatMetadata } from '../types/chat.ts';
import { type MessageState, toChatMessage } from './message.ts';

/** What the queue retains of the transcript the server is believed to hold. */
export interface ChatSaveBase {
  revision: number;
  title: string;
  metadata: ChatMetadata;
  states: MessageState[];
}

/**
 * One immutable save unit, scheduled with the queue.
 *
 * `saveId` is minted here rather than at send time so that every redelivery of this
 * record — a queue retry, a keepalive racing a flush — carries the same token and can
 * collapse to an acknowledgement on the server.
 */
export interface ChatSaveRecord {
  chatId: string;
  revision: number;
  /** Idempotency token for this exact save unit; one per scheduled record. */
  saveId: string;
  title: string;
  metadata: ChatMetadata;
  /**
   * The persisted transcript as `MessageState` objects — the projection
   * `toPersistedMessageStates` produces, placeholders already folded out. Stored rather
   * than wire messages so diffing is a reference comparison and snapshots cost a map.
   */
  states: MessageState[];
}

/** The PUT /api/chats/:id body — everything the server needs, nothing it doesn't. */
export interface ChatSaveBody {
  revision: number;
  /** Idempotency token; a replay of this exact save acknowledges instead of writing. */
  saveId: string;
  /** The server revision this delta is computed against. Compare-and-swap. */
  baseRevision: number;
  /** Present only when changed since the base. Full saves always carry both. */
  title?: string;
  metadata?: ChatMetadata;
  /**
   * The complete transcript order after this save — every message id, in position order.
   * Present only when the transcript changed. Row ids not listed are deleted.
   */
  order?: string[];
  /** The new or changed messages, addressed by id. Requires `order`. */
  upsert?: ChatMessage[];
}

/**
 * Diff a record against the retained base.
 *
 * Reference identity does all the work: reducer updates are pure, so a `MessageState`
 * that survived into this record untouched is the identical object the base holds, and
 * anything changed is a fresh one. `full` sends the whole document — used when there is
 * no trusted base at all, and for the one CAS retry after a stale answer.
 */
export function buildChatSaveBody(
  record: ChatSaveRecord,
  base: ChatSaveBase | undefined,
  options: { baseRevision?: number; full?: boolean } = {},
): ChatSaveBody {
  const full = options.full || !base;
  const body: ChatSaveBody = {
    revision: record.revision,
    saveId: record.saveId,
    baseRevision: options.baseRevision ?? base?.revision ?? 0,
  };
  if (full || record.title !== base?.title) body.title = record.title;
  if (full || record.metadata !== base?.metadata) body.metadata = record.metadata;

  const states = record.states;
  const baseStates = full ? [] : (base?.states ?? []);
  const sameOrder =
    states.length === baseStates.length &&
    states.every((message, index) => message === baseStates[index]);
  if (!sameOrder) {
    body.order = states.map((message) => message.id);
    if (base) {
      const retained = new Map(baseStates.map((message) => [message.id, message]));
      const changed = states.filter((message) => retained.get(message.id) !== message);
      if (changed.length) body.upsert = changed.map(toChatMessage);
    } else {
      body.upsert = states.map(toChatMessage);
    }
  }
  return body;
}
