/**
 * Revision-aware persistence for design sessions.
 *
 * The chat's binding of the same queue, keyed on `sessionId` instead of `chatId`. The
 * mechanism and its guarantees live in `src/lib/revisionQueue.ts`.
 */

import type { CocreatorSaveSnapshot } from '@shared/types/cocreator.ts';
import type { RevisionSaveQueueEvents, RevisionSaveTransport } from '../../lib/revisionQueue.ts';
import { RevisionSaveQueue } from '../../lib/revisionQueue.ts';

export type CocreatorSaveTransport = RevisionSaveTransport<CocreatorSaveSnapshot>;
export type CocreatorSaveQueueEvents = RevisionSaveQueueEvents<CocreatorSaveSnapshot>;

export class CocreatorSaveQueue extends RevisionSaveQueue<CocreatorSaveSnapshot> {
  constructor(
    save: CocreatorSaveTransport,
    delayMs: number,
    events: CocreatorSaveQueueEvents = {},
  ) {
    super(save, delayMs, (snapshot) => snapshot.sessionId, events);
  }
}
