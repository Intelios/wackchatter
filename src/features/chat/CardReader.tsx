/**
 * The card at reading width.
 *
 * The popover on the avatar is a glance; this is for when the answer is a paragraph rather
 * than a word. Same three bands, same state, wider measure — see `CardSheetView`, which
 * both surfaces render.
 *
 * It takes the chat column the way `FullscreenText` does: portaled into the shell's overlay
 * root and pinned to the column's grid cell, so the top bar and both side panels stay
 * visible and usable, and opening a panel compresses this exactly as it compresses the chat
 * underneath. Not a modal — the house rule is that the conversation stays live, and nothing
 * here needs the rest of the app inert to be correct.
 *
 * It also stands alone rather than being the popover's second act: `/card`, the chat menu
 * and Expand all land here, and only one of those three has an avatar to hang off.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, EditIcon } from '../../layout/icons.tsx';
import { CardSheetView, useCardSheetState } from './CardSheetView.tsx';
import { type CardSheet, readCardSheet } from './cardSheet.ts';
import type { CardStore } from './state/cardStore.ts';
import './CardReader.css';

const NO_CARD: CardSheet = {
  rung: 'raw',
  sections: [{ id: 'card', label: 'Card', text: '', source: { kind: 'card' } }],
};

export interface CardReaderInit {
  /** Prefilled search, from `/card <query>`. */
  query?: string;
  /** Where the popover was, so Expand does not lose your place. */
  sectionId?: string | null;
}

interface CardReaderProps {
  store: CardStore;
  init: CardReaderInit;
  onClose: () => void;
  onEditCharacter?: () => void;
  busy?: boolean;
}

export function CardReader({ store, init, onClose, onEditCharacter, busy }: CardReaderProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sheet = useMemo(
    () => (snapshot.card ? readCardSheet(snapshot.card, snapshot.render) : NO_CARD),
    [snapshot.card, snapshot.render],
  );
  const state = useCardSheetState(sheet, snapshot.avatar, init);

  // Captured on mount, while the thing that opened this still holds focus, so closing puts
  // the reader back where it came from — an avatar, the burger, or the composer.
  const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const overlayRoot = useMemo(() => document.querySelector('[data-overlay-root]'), []);

  /*
   * Escape closes, from anywhere in the document.
   *
   * The find box swallows Escape while it holds a query — clearing the search is the
   * nearer meaning of "undo" — so this only ever sees the second press. See the input's
   * own handler in `CardSheetView`.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      const opener = openerRef.current;
      // May have been unmounted while the reader was up — a transcript page can turn over
      // underneath it.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The overlay root only exists while an app destination is up; a null target is a
  // teardown race, and rendering nothing beats throwing on the way out.
  if (!overlayRoot) return null;

  return createPortal(
    <div
      className="card-reader"
      role="dialog"
      aria-modal="false"
      aria-label={`${snapshot.card?.name || 'Character'}'s card`}
    >
      <div className="card-reader__bar">
        <h2 className="card-reader__title">{snapshot.card?.name || 'Character card'}</h2>
        <div className="card-reader__actions">
          {onEditCharacter ? (
            <button
              type="button"
              className="wc-button wc-button--ghost"
              // Leaving for the editor aborts the generation in flight, so mid-stream this
              // would silently throw away the reply being written.
              disabled={busy}
              title={busy ? 'Wait for the current reply to finish.' : 'Edit this card'}
              onClick={onEditCharacter}
            >
              <EditIcon />
              Edit card
            </button>
          ) : null}
          <button
            type="button"
            className="wc-button wc-button--ghost"
            title="Close (Esc)"
            aria-label="Close the card"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="card-reader__measure">
        <CardSheetView sheet={sheet} variant="reader" autoFocus {...state} />
      </div>
    </div>,
    overlayRoot,
  );
}
