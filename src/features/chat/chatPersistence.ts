/**
 * Revision-aware client persistence for chats.
 *
 * A queued save owns its complete snapshot. It never receives a state getter, which is
 * the boundary that prevents an A timer from saving B's transcript under A's id.
 *
 * The mechanism lives in `src/lib/revisionQueue.ts`, shared with the Co-Creator's session
 * saves. This file is the chat's binding of it: the key is `chatId`, and the public surface
 * is unchanged.
 */

import type { ChatSaveSnapshot } from '@shared/types/chat.ts';
import type { RevisionSaveQueueEvents, RevisionSaveTransport } from '../../lib/revisionQueue.ts';
import { RevisionSaveQueue } from '../../lib/revisionQueue.ts';

export type ChatSaveTransport = RevisionSaveTransport<ChatSaveSnapshot>;
export type ChatSaveQueueEvents = RevisionSaveQueueEvents<ChatSaveSnapshot>;

/** A small per-chat queue; different chats may save independently, never out of order. */
export class ChatSaveQueue extends RevisionSaveQueue<ChatSaveSnapshot> {
  constructor(save: ChatSaveTransport, delayMs: number, events: ChatSaveQueueEvents = {}) {
    super(save, delayMs, (snapshot) => snapshot.chatId, events);
  }
}
