/**
 * How many transcript messages to render initially and load per page.
 *
 * The window is a contiguous `[start, end)` slice of the transcript, so long chats keep
 * both a bounded DOM cost and a contiguous read: no estimated-height placeholders or
 * holes. Both ends move — scrolling up prepends a page, scrolling down appends one, and
 * a jump mounts a single page around its target instead of every newer message.
 */
export const TRANSCRIPT_PAGE_SIZE = 40;

/**
 * The most messages the window may hold before the far edge evicts.
 *
 * Prepending past this drops the newest end; appending and tail-anchored growth drop the
 * oldest end — the window slides after the reader rather than growing one row per page
 * until every loaded message is mounted. Three pages keeps a full page either side of a
 * viewport-sized neighbourhood: close enough that scrolling back re-mounts before the
 * reader notices, small enough that a transcript of any length stays cheap.
 */
export const TRANSCRIPT_MAX_MESSAGES = TRANSCRIPT_PAGE_SIZE * 3;

export interface TranscriptWindow {
  /** First visible message index, inclusive. */
  start: number;
  /** First message index not rendered — the slice's exclusive end. */
  end: number;
}

/** The newest page of a transcript. */
export function initialTranscriptWindow(messageCount: number): TranscriptWindow {
  return {
    start: Math.max(0, messageCount - TRANSCRIPT_PAGE_SIZE),
    end: messageCount,
  };
}

/**
 * Extend the window one page back. At capacity the newest end evicts the same distance,
 * so the reader gains history without the mount count growing.
 */
export function prependTranscriptWindow(
  window: TranscriptWindow,
  messageCount: number,
): TranscriptWindow {
  const start = Math.max(0, window.start - TRANSCRIPT_PAGE_SIZE);
  return {
    start,
    end: Math.min(messageCount, Math.min(window.end, start + TRANSCRIPT_MAX_MESSAGES)),
  };
}

/**
 * Extend the window one page forward. At capacity the oldest end evicts the same
 * distance — the mirror of prepending.
 */
export function appendTranscriptWindow(
  window: TranscriptWindow,
  messageCount: number,
): TranscriptWindow {
  const end = Math.min(messageCount, window.end + TRANSCRIPT_PAGE_SIZE);
  return {
    start: Math.max(window.start, end - TRANSCRIPT_MAX_MESSAGES),
    end,
  };
}

/**
 * Grow a tail-anchored window to cover new messages, evicting the oldest end at
 * capacity. The reader's tail stays live; the rows that scroll out of the window come
 * back through the ordinary page loads.
 */
export function growTranscriptWindow(
  window: TranscriptWindow,
  messageCount: number,
): TranscriptWindow {
  return {
    start: Math.min(messageCount, Math.max(window.start, messageCount - TRANSCRIPT_MAX_MESSAGES)),
    end: messageCount,
  };
}

/**
 * One page around a target index, so `/jump` mounts a bounded window. Targets inside the
 * last page anchor to the tail — jumping "to the end" keeps bottom-follow semantics.
 */
export function windowForJump(target: number, messageCount: number): TranscriptWindow {
  if (messageCount <= TRANSCRIPT_PAGE_SIZE) return initialTranscriptWindow(messageCount);
  const safe = Math.min(Math.max(0, target), messageCount - 1);
  const half = Math.floor(TRANSCRIPT_PAGE_SIZE / 2);
  const start = Math.max(0, safe - half);
  const end = Math.min(messageCount, start + TRANSCRIPT_PAGE_SIZE);
  return { start: Math.max(0, end - TRANSCRIPT_PAGE_SIZE), end };
}
