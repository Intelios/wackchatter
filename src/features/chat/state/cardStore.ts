/**
 * The open character's card, kept out of the transcript's props.
 *
 * The card sheet hangs off an avatar, so every message bubble needs a way to reach the
 * card — and bubbles are memoised precisely so a long chat does not re-render forty rows
 * whenever anything changes. Handing them the card as a prop would undo that: `setDetail`
 * runs on every character-editor autosave, debounced at 700ms, so typing in the editor
 * with a chat open would repaint the whole visible transcript twice a second.
 *
 * So the card travels the way streamed text does — an external store with an identity that
 * never changes, subscribed by the one leaf that needs it, which only exists while a sheet
 * is actually open. See `streamStore.ts`; this is the same bargain at a much lower
 * frequency.
 *
 * The section memory below is deliberately NOT part of the store. Remembering which
 * section you had open is a per-character preference, not shared state: notifying every
 * mounted sheet because you clicked a chip in one of them would be work for nothing, and
 * routing it through settings would put a server round-trip on a chip click. A module-level
 * map, lost on reload, is the whole feature — the fallback is Appearance, which is where
 * you wanted to be anyway. The colour cache in `avatarColor.ts` keeps state the same way.
 */

import type { CardDataV2 } from '@shared/types/card.ts';

export interface CardSnapshot {
  /** The PNG filename, the card's identity. Null when no character is open. */
  avatar: string | null;
  card: CardDataV2 | null;
  /** Resolves macros in card text — the greeting's own pass, on a fresh runtime. */
  render: (text: string) => string;
}

export interface CardStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CardSnapshot;
  /** Publishes only when something actually changed — see the note in `set`. */
  set(next: CardSnapshot): void;
}

const IDLE: CardSnapshot = { avatar: null, card: null, render: (text) => text };

export function createCardStore(): CardStore {
  const listeners = new Set<() => void>();
  // Cached: returning a fresh object from getSnapshot makes React loop forever.
  let snapshot: CardSnapshot = IDLE;

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return snapshot;
    },

    /*
     * The caller syncs this from an effect, which means it arrives as a fresh object
     * literal on every render of `ChatView` — most of them carrying exactly what is
     * already here. Publishing those would notify an open sheet dozens of times a second
     * during a generation, which is the churn this store exists to prevent.
     *
     * Identity, not deep equality: `card` is the same object until `setDetail` replaces
     * it, and `render` the same closure until the chat state it closes over moves. Both
     * are the changes a reader should actually see.
     */
    set(next: CardSnapshot) {
      if (
        next.avatar === snapshot.avatar &&
        next.card === snapshot.card &&
        next.render === snapshot.render
      ) {
        return;
      }
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

/** Which section each card was last read at, this session. Keyed by avatar filename. */
const openSections = new Map<string, string>();

export function rememberSection(avatar: string, sectionId: string): void {
  if (!avatar) return;
  openSections.set(avatar, sectionId);
}

export function recallSection(avatar: string | null): string | null {
  if (!avatar) return null;
  return openSections.get(avatar) ?? null;
}

/** Test seam. Nothing in the app clears this — a session's memory lasts the session. */
export function forgetAllSections(): void {
  openSections.clear();
}
