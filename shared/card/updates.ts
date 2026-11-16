/**
 * The one rule every writer of the card's `updates` field follows: an update that says
 * nothing is not an update.
 *
 * The Studio's editor keeps a row with no text in its own state so there is something to
 * type into, but what it schedules is filtered through this — the card never gains a
 * changelog entry no one wrote. The reading surfaces (the Characters panel's timeline, the
 * card reader's section) run it as defence against a card written by hand.
 */
import type { CardUpdate } from '../types/card.ts';

export function cleanUpdates(updates: readonly CardUpdate[] | undefined): CardUpdate[] {
  return (updates ?? []).filter((entry) => entry.text.trim());
}
