import type { GenMode } from './state/chatReducer.ts';

/** Which way the incoming swipe content travels: `next` slides in from the right. */
export type SwipeMotionDir = 'prev' | 'next';

export interface SwipeMotionSnapshot {
  /** The active alternate index on this render. */
  swipeId: number;
  /** Whether this message is the one a generation is streaming into. */
  streaming: boolean;
  /** The generation in flight, or null when idle. */
  mode: GenMode | null;
  /** The active alternate from the previous render of this bubble. */
  prevSwipeId: number;
  /** Whether the message was streaming on the previous render. */
  prevStreaming: boolean;
}

/**
 * Decide whether a message swap warrants the swipe animation, and from where.
 *
 * Presentation-only: nothing here touches chat state or persistence. The bubble calls
 * this in a layout effect with its previous render's refs, and replays the entrance
 * animation only when it returns a direction — never on mount, so loading a chat does
 * not rain entrances across the transcript, and never for a plain send, whose placeholder
 * just appears.
 *
 * The three transitions that animate:
 *  - a cached swipe (`swipe/select` while idle): the active alternate moved;
 *  - an overswipe (`gen/started` mode `swipe`): a blank alternate was appended and is
 *    streaming, so the "new card" enters from the right;
 *  - a regenerate (`gen/started` mode `regenerate`): the fresh placeholder bubble mounts
 *    already streaming, and a re-roll reads as the reply being replaced.
 *
 * Everything else — stream ticks, settle, a failed regenerate's restore (which remounts
 * the original bubble), continue — animates nothing.
 */
export function resolveSwipeMotion(snapshot: SwipeMotionSnapshot): SwipeMotionDir | null {
  const { swipeId, streaming, mode, prevSwipeId, prevStreaming } = snapshot;
  const swipeChanged = swipeId !== prevSwipeId;
  const streamStarted = streaming && !prevStreaming;

  // Re-roll: the placeholder bubble mounts fresh, already streaming.
  if (streamStarted && mode === 'regenerate') return 'next';
  // Overswipe: an appended blank alternate starts streaming.
  if (streamStarted && swipeChanged && mode === 'swipe') return 'next';
  // Cached swipe: the selection moved while idle. A failed overswipe's revert lands
  // here too, which reads as the alternate being swiped back into place.
  if (!streaming && swipeChanged) return swipeId > prevSwipeId ? 'next' : 'prev';

  return null;
}
