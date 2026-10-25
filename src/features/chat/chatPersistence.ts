/**
 * Revision-aware persistence for chats.
 *
 * A queued save owns its complete record. It never receives a state getter, which is
 * the boundary that prevents an A timer from saving B's transcript under A's id.
 *
 * The mechanism lives in `src/lib/revisionQueue.ts`, shared with the Co-Creator's
 * session saves. This file is the chat's binding of it, and it adds one more thing on
 * top: instead of shipping every record wholesale it diffs each one against the
 * *base* — the document the server is believed to hold — so a save on a long chat
 * uploads the changed messages rather than the transcript.
 *
 * Where the base comes from:
 *  - `adopt(key, revision, base)` registers the document a chat was loaded as. Only a
 *    queue at rest accepts it: with a save pending or in flight the loaded copy is
 *    older than what is already queued, and diffing against it would write the wrong
 *    delta.
 *  - every acknowledged save replaces the base with the record that was sent — its
 *    states are then provably the server's rows.
 *
 * The ordering guarantees are unchanged: revisions per chat are serialised and strictly
 * increasing, the server applies a save only while it still holds `baseRevision`, and a
 * redelivery carrying the same `saveId` acknowledges instead of writing twice. A stale
 * answer gets one compare-and-swap retry with the full document — the recovery for a
 * lost acknowledgement — and anything else is a real conflict the caller sees.
 */

import {
  buildChatSaveBody,
  type ChatSaveBase,
  type ChatSaveBody,
  type ChatSaveRecord,
} from '@shared/chat/save.ts';
import { staleRevisionFrom } from '../../lib/api.ts';
import type { RevisionSaveQueueEvents } from '../../lib/revisionQueue.ts';
import { RevisionSaveQueue } from '../../lib/revisionQueue.ts';

export type ChatSaveTransport = (
  chatId: string,
  body: ChatSaveBody,
  options?: Pick<RequestInit, 'keepalive'>,
) => Promise<unknown>;
export type ChatSaveQueueEvents = RevisionSaveQueueEvents<ChatSaveRecord>;

/** A small per-chat queue; different chats may save independently, never out of order. */
export class ChatSaveQueue extends RevisionSaveQueue<ChatSaveRecord> {
  private readonly bases: Map<string, ChatSaveBase>;
  /** The greatest revision the server is known to hold, base content or not. */
  private readonly acked: Map<string, number>;

  constructor(save: ChatSaveTransport, delayMs: number, events: ChatSaveQueueEvents = {}) {
    const bases = new Map<string, ChatSaveBase>();
    const acked = new Map<string, number>();

    const send = async (
      record: ChatSaveRecord,
      options?: Pick<RequestInit, 'keepalive'>,
    ): Promise<void> => {
      const chatId = record.chatId;
      const base = bases.get(chatId);
      try {
        await save(
          chatId,
          buildChatSaveBody(record, base, {
            baseRevision: base?.revision ?? acked.get(chatId) ?? 0,
          }),
          options,
        );
      } catch (error) {
        const stale = staleRevisionFrom(error);
        /*
         * The server no longer holds the revision this delta was computed against. When
         * that is an older revision — overwhelmingly a response we never saw — retry
         * once as the whole document on a fresh compare-and-swap: it lands iff nothing
         * else wrote since. A stale answer at or past our own revision is a real
         * conflict: the server revision never moves backwards, so there is no revision
         * this record could still claim.
         */
        if (!stale || stale.currentRevision >= record.revision) throw error;
        await save(
          chatId,
          buildChatSaveBody(record, undefined, {
            full: true,
            baseRevision: stale.currentRevision,
          }),
          options,
        );
      }
    };

    super(send, delayMs, (record) => record.chatId, {
      ...events,
      onSaved: (record) => {
        // The acknowledged record is now provably the server's document: it becomes the
        // base the next save diffs against.
        bases.set(record.chatId, {
          revision: record.revision,
          title: record.title,
          metadata: record.metadata,
          states: record.states,
        });
        acked.set(record.chatId, Math.max(acked.get(record.chatId) ?? 0, record.revision));
        events.onSaved?.(record);
      },
    });
    this.bases = bases;
    this.acked = acked;
  }

  /**
   * Record the revision received from the server when a chat is loaded.
   *
   * `base` is the just-loaded document. A queue at rest adopts it as the diff base —
   * which is what makes the first save after opening a long chat incremental instead
   * of a full upload. Offered while anything is pending or in flight it is ignored:
   * the queue's own records are already newer than anything a load could return.
   */
  override adopt(key: string, revision: number, base?: Omit<ChatSaveBase, 'revision'>): void {
    this.acked.set(key, Math.max(this.acked.get(key) ?? 0, revision));
    if (base && !this.isDirty(key) && !this.running.has(key)) {
      this.bases.set(key, { revision, ...base });
    }
    super.adopt(key, revision);
  }

  /**
   * No copy. The record holds the reducer's own immutable state objects — the same
   * references the UI renders from — so cloning a transcript-sized document on every
   * revision would double the cost of saving for a guarantee purity already gives.
   */
  protected override own(record: ChatSaveRecord): ChatSaveRecord {
    return record;
  }
}
