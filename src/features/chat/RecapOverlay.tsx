/**
 * "Previously on…" — the recap, as a broadcast title card floating over the chat column.
 *
 * Takes the chat column the way `CardReader` and `BranchTree` do: portaled into the shell's
 * overlay root and pinned to the column's grid cell, so the top bar and both panels stay
 * visible and opening a panel compresses this exactly as it compresses the chat underneath.
 * Unlike those two it is sized to a card rather than the whole cell (see RecapOverlay.css),
 * so the transcript stays visible around it. Not a modal — the conversation stays live, and
 * nothing here needs the rest of the app inert to be correct.
 *
 * The episode framing is the point: an eyebrow, the chat title as the "show", an episode
 * chip, a starring credit and a credits colophon. Nothing here is a metric the app tracks —
 * the episode number is the message count, and the credit line is the character and the
 * persona this chat is played as.
 *
 * Read-only. The recap is re-run by clicking the button again, so there is no action here
 * but closing; Stop belongs to the composer, where the one generation status lives.
 *
 * While the recap streams, the text arrives through `streamStore` and is subscribed to only
 * while this run is active — the same shape the composer uses for an impersonation, and for
 * the same reason: a surface re-rendering through every token of every reply would undo the
 * point of keeping streaming text out of React state.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx';
import { CloseIcon } from '../../layout/icons.tsx';
import { Markdown } from './Markdown.tsx';
import { StreamingText } from './StreamingText.tsx';
import type { StreamSnapshot, StreamStore } from './state/streamStore.ts';
import './RecapOverlay.css';

/** How much of a long chat had to be dropped so the request would fit. */
export interface RecapMeta {
  dropped: number;
  total: number;
}

export interface RecapViewState {
  /** `active` while the request is in flight; the overlay follows the stream then. */
  status: 'active' | 'done' | 'failed';
  /** The settled (or partial) text. Empty while nothing has arrived. */
  text: string;
  /** Set only when the run produced nothing at all. */
  error: string | null;
}

const IDLE_STREAM: StreamSnapshot = { text: '', reasoning: '', active: false, incremental: false };

interface RecapOverlayProps {
  view: RecapViewState;
  meta: RecapMeta | null;
  stream: StreamStore;
  /** The chat's title — the name of the "show" the card is titled after. */
  title?: string;
  /** The character, for the starring credit. */
  characterName: string;
  /** Their dialogue colour, when dialogue colouring is on; tints only the name. */
  characterDialogueColor?: string | null;
  /** The persona this chat is played as, for the second credit. */
  personaName?: string | null;
  /** The "episode number": how many messages the recap was cut from. */
  episode: number;
  onClose: () => void;
}

export function RecapOverlay({
  view,
  meta,
  stream,
  title,
  characterName,
  characterDialogueColor,
  personaName,
  episode,
  onClose,
}: RecapOverlayProps) {
  // Captured on mount, while the control that opened this still holds focus, so closing
  // puts the overlay back where it came from — the burger or the composer tray.
  const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const overlayRoot = useMemo(() => document.querySelector('[data-overlay-root]'), []);

  const close = useCallback(() => {
    onClose();
    const opener = openerRef.current;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [onClose]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const live = view.status === 'active';
  const subscribeStream = useCallback(
    (listener: () => void) => (live ? stream.subscribe(listener) : () => {}),
    [live, stream],
  );
  const snapshot = useSyncExternalStore(subscribeStream, () =>
    live ? stream.getSnapshot() : IDLE_STREAM,
  );
  // `active` gates the stream: `end()` keeps its text, so without this a fresh recap would
  // show the previous run's last frame until its own `begin()` clears it.
  const text = live ? (snapshot.active ? snapshot.text : '') : view.text;

  // Focus lands on the surface, not the close button: the recap is read top-down before it
  // is dismissed, and Escape has a home from the first frame.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    surfaceRef.current?.focus({ preventScroll: true });
  }, []);

  // The overlay root only exists while an app destination is up; a null target is a
  // teardown race, and rendering nothing beats throwing on the way out.
  if (!overlayRoot) return null;

  return createPortal(
    <ErrorBoundary where="the recap" resetKeys={[view.status]}>
      <div
        ref={surfaceRef}
        className={`recap${live ? ' recap--live' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-label="Previously on"
        tabIndex={-1}
      >
        <div className="recap__head">
          <p className="recap__eyebrow">Previously on</p>
          <button
            type="button"
            className="wc-button wc-button--ghost recap__close"
            title="Close (Esc)"
            aria-label="Close the recap"
            onClick={close}
          >
            <CloseIcon />
          </button>
        </div>

        {/* The show's name. `h2` carries it; the eyebrow above is the announcement. */}
        <h2 className="recap__title">{title || 'This chat'}</h2>

        {/*
         * The credits. Decorative framing, not data the app tracks: the episode number is
         * the message count, and the cast is the character and the persona. The character's
         * name takes their own dialogue colour — the only colour in the card.
         */}
        <p className="recap__credits">
          <span className="recap__episode">Episode {episode}</span>
          <span className="recap__starring">
            Starring{' '}
            <span
              className="recap__cast"
              style={characterDialogueColor ? { color: characterDialogueColor } : undefined}
            >
              {characterName}
            </span>{' '}
            · and {personaName || 'you'}
          </span>
        </p>

        <span className="recap__rule" aria-hidden="true" />

        {meta && meta.dropped > 0 ? (
          <p className="recap__advisory">
            <span className="recap__advisory-tag">Viewer advisory</span>
            Earlier turns did not fit — recapping the last {meta.total - meta.dropped} of{' '}
            {meta.total} messages.
          </p>
        ) : null}

        <div className="recap__body">
          {view.status === 'failed' && view.error ? (
            <p className="recap__error">{view.error}</p>
          ) : null}

          {live && !text ? <p className="recap__waiting">Recapping…</p> : null}

          {/*
           * `StreamingText` behind the `active` gate, exactly as the composer does it for
           * an impersonation: it reads the store raw, so without the gate a fresh recap
           * would paint the previous generation's last frame before its own `begin()`.
           * Markdown is deliberately not used mid-stream — it re-parses the whole growing
           * string every tick, which is quadratic over a recap-sized reply.
           */}
          {live && snapshot.active ? (
            <div className="recap__text">
              <StreamingText store={stream} hideReasoning />
            </div>
          ) : null}

          {!live && !text && view.status === 'done' ? (
            <p className="recap__waiting">Nothing came back. Try again.</p>
          ) : null}

          {!live && text ? <Markdown text={text} className="recap__text" /> : null}
        </div>

        {/* Credits-style colophon: that it is over, and what it was cut from. */}
        <p className="recap__footer">
          <span>{view.status === 'failed' ? 'Recap failed' : 'End of recap'}</span>
          <span className="recap__leader" aria-hidden="true" />
          <span>
            {episode} {episode === 1 ? 'message' : 'messages'}
          </span>
        </p>
      </div>
    </ErrorBoundary>,
    overlayRoot,
  );
}
