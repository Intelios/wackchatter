/**
 * "Previously on…" — the recap, at reading width over the chat column.
 *
 * Takes the chat column the way `CardReader` and `BranchTree` do: portaled into the shell's
 * overlay root and pinned to the column's grid cell, so the top bar and both panels stay
 * visible and opening a panel compresses this exactly as it compresses the chat underneath.
 * Not a modal — the conversation stays live, and nothing here needs the rest of the app
 * inert to be correct.
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
  /** The chat's title, for the subtitle. */
  title?: string;
  onClose: () => void;
}

export function RecapOverlay({ view, meta, stream, title, onClose }: RecapOverlayProps) {
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

  // The lamp's caption: recording while it runs, and whatever the tape did afterwards.
  const statusWord = live ? 'Rec' : view.status === 'failed' ? 'Off air' : 'Replay';

  return createPortal(
    <ErrorBoundary where="the recap" resetKeys={[view.status]}>
      <div
        ref={surfaceRef}
        className={`recap${live ? ' recap--live' : ''}${view.status === 'failed' ? ' recap--off-air' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-label="Previously on"
        tabIndex={-1}
      >
        <div className="recap__bar">
          <p className="recap__status">
            <span className="recap__lamp" aria-hidden="true" />
            {statusWord}
          </p>
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

        {/*
         * The title card. `h2` carries the accessible name; everything decorative here —
         * the sweep rule, the tracked-out casing — is presentation only.
         */}
        <header className="recap__card">
          <h2 className="recap__title">Previously on…</h2>
          <p className="recap__subtitle">{title || 'This chat'}</p>
          <span className="recap__rule" aria-hidden="true" />
        </header>

        {meta && meta.dropped > 0 ? (
          <p className="recap__advisory">
            <span className="recap__advisory-tag">Advisory</span>
            Earlier turns did not fit — recapping the last{' '}
            {meta.total - meta.dropped} of {meta.total} messages.
          </p>
        ) : null}

        <div className="recap__body">
          <div className="recap__measure">
            {view.status === 'failed' && view.error ? (
              <p className="recap__error">{view.error}</p>
            ) : null}

            {live && !text ? <p className="recap__waiting">Threading the reel…</p> : null}

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
        </div>

        {/* Credits-style colophon: what this was cut from, and that it is over. */}
        <p className="recap__footer">
          <span>{live ? 'Recording' : view.status === 'failed' ? 'Off air' : 'End of recap'}</span>
          <span className="recap__leader" aria-hidden="true" />
          {meta ? (
            <span>
              {meta.total} {meta.total === 1 ? 'message' : 'messages'}
            </span>
          ) : null}
        </p>
      </div>
    </ErrorBoundary>,
    overlayRoot,
  );
}
