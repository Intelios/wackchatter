import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  appendTranscriptWindow,
  growTranscriptWindow,
  initialTranscriptWindow,
  prependTranscriptWindow,
  type TranscriptWindow,
} from './transcriptWindow.ts';

/** How far from the top or bottom the reader has to be before the next page appears. */
export const LOAD_AHEAD_PX = 800;

interface TranscriptWindowState {
  /** The transcript this window belongs to; a stale key means the fallback tail page. */
  key: string | null;
  start: number;
  end: number;
}

export interface TranscriptWindowController {
  /** First mounted message index — slice the transcript as `messages.slice(start, end)`. */
  start: number;
  /** First unmounted index — the slice's exclusive end. */
  end: number;
  /** Replace the window outright — `/jump` mounts one page around its target. */
  setWindowRange: (window: TranscriptWindow) => void;
  /**
   * Keep the load-ahead bands quiet until the reader actually scrolls. A jump's own
   * centering scroll lands inside the bands; without the suppress each hop cascades
   * page loads and restores that walk the viewport away from the target.
   */
  suppressLoadAhead: () => void;
  /**
   * Set while the view moves the scroll itself. The listener treats marked events as ours —
   * they neither count as a reader scroll nor clear a jump's load-ahead suppression.
   */
  programmaticScrollRef: RefObject<boolean>;
  /**
   * Re-anchor the window to the tail and scroll to it — what sending a message asks for.
   * A window not at the tail never renders the new rows at all, so a send from the middle
   * of a long transcript would otherwise have nowhere to land. An already-tail-anchored
   * window is left alone, pages loaded above it included.
   */
  snapToEnd: () => void;
}

/**
 * The sliding transcript window: which slice of the message array is mounted, and the
 * scroll protocol that moves it.
 *
 * One contiguous `[start, end)` — pages load at the edge the reader approaches, the far
 * edge evicts at `TRANSCRIPT_MAX_MESSAGES`, and DOM position is preserved across the
 * commit by anchoring on the first row that survives: a row `data-message-id` far enough
 * in that the eviction cannot remove it. Row identity rather than a scrollHeight delta,
 * because a commit can add rows above AND evict rows below in either order.
 *
 * `useStickToBottom` still owns the follow; this hook owns the pages. The listener must
 * subscribe AFTER the follow's: at a page boundary the follow's distance check reads as
 * "at the bottom" and would re-engage — this hook's `stopFollowing` is the deciding call.
 *
 * Rows must carry `data-message-id` for the anchor to find them; a transcript that maps
 * a message to nothing renders one row fewer than the count, and the anchor index shifts
 * by that many — a small jump, not a crash.
 */
export function useTranscriptWindow({
  transcriptKey,
  messageCount,
  scrollRef,
  contentRef,
  scrollToBottom,
  stopFollowing,
}: {
  /**
   * The transcript's identity — chat id, session id, test id. Folding a reload counter
   * into the key (`${id}:${reload}`) makes a reload reset the window like a switch does.
   */
  transcriptKey: string | null;
  /** `messages.length`, so the hook never needs the transcript itself. */
  messageCount: number;
  scrollRef: RefObject<HTMLElement | null>;
  /** The element the rows live in — the DOM the anchor queries and growth watches. */
  contentRef: RefObject<HTMLElement | null>;
  scrollToBottom: () => void;
  stopFollowing: () => void;
}): TranscriptWindowController {
  const [window, setWindow] = useState<TranscriptWindowState>({ key: null, start: 0, end: 0 });

  // Latest-value mirrors, so callbacks and updaters read the live transcript rather than
  // a stale render's — the same bargain the rest of this codebase makes.
  const countRef = useRef(messageCount);
  countRef.current = messageCount;
  const keyRef = useRef(transcriptKey);
  keyRef.current = transcriptKey;

  const suppressLoadAheadRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  // The row whose document position a page change must preserve, captured before the
  // commit and restored after it. The DOM element itself, not its id: re-querying by id
  // would work, but a kept reference cannot collide with a recycled row.
  const scrollAnchorRef = useRef<{ element: HTMLElement; offset: number } | null>(null);

  // Jump to the end when a different transcript opens. A transcript can render its loaded
  // messages before this effect has set state — the fallback derivation below keeps that
  // first paint to the tail page instead of every message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on transcript identity
  useEffect(() => {
    scrollAnchorRef.current = null;
    suppressLoadAheadRef.current = false;
    setWindow({ key: transcriptKey, ...initialTranscriptWindow(countRef.current) });
    scrollToBottom();
  }, [transcriptKey]);

  const fallback = initialTranscriptWindow(messageCount);
  const sameTranscript = window.key === transcriptKey;
  const start = sameTranscript ? Math.min(window.start, messageCount) : fallback.start;
  const end = sameTranscript ? Math.min(window.end, messageCount) : fallback.end;

  // While the window is not anchored to the tail, bottom-follow must stay off: the
  // "bottom" of the scroll container is a page boundary, not the transcript's end, and an
  // auto-scroll there would cascade page loads with no reader action. A ref so the scroll
  // listener can read it without re-subscribing on every message.
  const atEndRef = useRef(true);
  atEndRef.current = end >= messageCount;

  /**
   * Capture the row to hold still through the coming commit. `rowIndex` counts the
   * transcript's mounted rows — `0` for a prepend (the first mounted row survives), the
   * incoming start's offset for an append (the evicted rows are what push it down).
   * Offsets are measured against the scroller so the restore lands wherever the reader
   * was, not where the document begins.
   */
  const captureScrollAnchor = useCallback(
    (rowIndex: number) => {
      const scroll = scrollRef.current;
      const content = contentRef.current;
      if (!scroll || !content) return;
      const el = content.querySelectorAll<HTMLElement>('[data-message-id]')[rowIndex];
      if (!el) return;
      scrollAnchorRef.current = {
        element: el,
        offset: el.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
      };
    },
    [scrollRef, contentRef],
  );

  // A page change adds DOM on one side and evicts on the other. Restore the anchor's
  // viewport position after the layout commits rather than leaving the reader where
  // freshly added or removed rows shoved them. Runs on every commit — the anchor is
  // consume-once, so a later unrelated render cannot pick it up twice.
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    const scroll = scrollRef.current;
    if (!anchor || !scroll) return;
    scrollAnchorRef.current = null;
    // The row itself can be evicted by a larger change than the capture expected (a burst
    // growth, a jump racing a page load). Better one jump than anchoring a ghost.
    if (!anchor.element.isConnected) return;
    const rect = anchor.element.getBoundingClientRect();
    scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - anchor.offset;
  });

  const loadOlderMessages = useCallback(() => {
    if (!sameTranscript || start === 0) return;
    // Row 0 of the mounted slice survives every prepend: the eviction removes from the
    // far end and cannot reach it while a page fits inside the cap.
    captureScrollAnchor(0);
    setWindow((current) =>
      current.key === keyRef.current
        ? {
            key: current.key,
            ...prependTranscriptWindow(
              { start: current.start, end: current.end },
              countRef.current,
            ),
          }
        : current,
    );
  }, [sameTranscript, start, captureScrollAnchor]);

  const loadNewerMessages = useCallback(() => {
    if (!sameTranscript || end >= messageCount) return;
    // The first row the append cannot evict — while the window stays under the cap that
    // is the old first row itself, so the capture is a no-op in the common case.
    const next = appendTranscriptWindow({ start, end }, messageCount);
    captureScrollAnchor(next.start - start);
    setWindow((current) =>
      current.key === keyRef.current
        ? {
            key: current.key,
            ...appendTranscriptWindow({ start: current.start, end: current.end }, countRef.current),
          }
        : current,
    );
  }, [sameTranscript, end, messageCount, start, captureScrollAnchor]);

  // Scrolling up loads the next older page on the way — the reader is never made to ask.
  // The far edge's page loads the same way, but only while the window is not at the
  // transcript's end: there the stick-to-bottom follow owns the edge, and the two would
  // cascade page loads against each other.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      suppressLoadAheadRef.current = false;
      if (!atEndRef.current) stopFollowing();
      if (scroll.scrollTop < LOAD_AHEAD_PX) loadOlderMessages();
      if (atEndRef.current) return;
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < LOAD_AHEAD_PX) {
        loadNewerMessages();
      }
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, [scrollRef, loadOlderMessages, loadNewerMessages, stopFollowing]);

  // The listeners run on scroll events; a page too short to scroll never fires one. After
  // a transcript opens, a page lands, or a jump lands, keep loading while the reader is
  // still inside the load-ahead band. A jump suppresses both until the reader scrolls —
  // the centering scroll is not a request for more pages — and a programmatic scroll
  // means the position is one of ours: reading it as a reader's band entry would load a
  // page nobody asked for.
  useLayoutEffect(() => {
    if (suppressLoadAheadRef.current || programmaticScrollRef.current) return;
    const scroll = scrollRef.current;
    if (!scroll || !sameTranscript || start === 0) return;
    if (scroll.scrollTop >= LOAD_AHEAD_PX) return;
    loadOlderMessages();
  }, [sameTranscript, start, loadOlderMessages, scrollRef]);

  useLayoutEffect(() => {
    if (suppressLoadAheadRef.current || programmaticScrollRef.current) return;
    const scroll = scrollRef.current;
    if (!scroll || !sameTranscript || atEndRef.current) return;
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= LOAD_AHEAD_PX) return;
    loadNewerMessages();
  });

  // A window anchored to the tail follows it. Without this, a reply streaming into a
  // window whose end was computed before the growth would land past the rendered rows and
  // be invisible — the transcript would look like the model said nothing. Past the cap
  // the oldest end evicts, anchored like an append so the reader's rows stay put.
  const lastCountRef = useRef(messageCount);
  useEffect(() => {
    const previous = lastCountRef.current;
    lastCountRef.current = messageCount;
    if (!sameTranscript) return;
    // A transcript whose key was known before its messages arrived — an async session
    // load — resets to the tail page rather than "growing": the {0,0} window reads as
    // tail-anchored (end 0 >= previous 0), and growing it would land the reader
    // mid-history at a scrolled-up position instead of the end the open promises.
    if (previous === 0 && messageCount > 0) {
      setWindow({ key: keyRef.current, ...initialTranscriptWindow(messageCount) });
      // Marked programmatic like snapToEnd's: this scroll fires on the not-yet-grown DOM,
      // landing inside the load-ahead band — unmarked, the listener would read it as a
      // reader scroll and prepend a page at open.
      programmaticScrollRef.current = true;
      scrollToBottom();
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
      return;
    }
    if (messageCount <= previous || window.end < previous) return;
    const grown = growTranscriptWindow({ start, end }, messageCount);
    if (grown.start !== start) captureScrollAnchor(grown.start - start);
    setWindow((current) =>
      current.key === keyRef.current && current.end >= previous
        ? {
            key: current.key,
            ...growTranscriptWindow({ start: current.start, end: current.end }, countRef.current),
          }
        : current,
    );
  });

  const setWindowRange = useCallback((next: TranscriptWindow) => {
    setWindow({ key: keyRef.current, start: next.start, end: next.end });
  }, []);

  const suppressLoadAhead = useCallback(() => {
    suppressLoadAheadRef.current = true;
  }, []);

  const snapToEnd = useCallback(() => {
    suppressLoadAheadRef.current = false;
    const count = countRef.current;
    const key = keyRef.current;
    setWindow((current) =>
      current.key === key && current.end >= count
        ? current
        : { key, ...initialTranscriptWindow(count) },
    );
    // Marked like a jump's centering scroll, and for the opposite reason: the listener
    // still reads the pre-snap atEnd, so it would answer our own scroll by dropping the
    // follow the snap just re-engaged. Released after the scroll event this queues.
    programmaticScrollRef.current = true;
    scrollToBottom();
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [scrollToBottom]);

  return {
    start,
    end,
    setWindowRange,
    suppressLoadAhead,
    programmaticScrollRef,
    snapToEnd,
  };
}
