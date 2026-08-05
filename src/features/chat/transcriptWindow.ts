/**
 * How many transcript messages to render initially and load per page.
 *
 * The window is a contiguous `[start, end)` slice of the transcript, so long chats keep
 * both a bounded DOM cost and a contiguous read: no estimated-height placeholders or
 * holes. Both ends move — scrolling up prepends a page, scrolling down appends one, and
 * a jump mounts a single page around its target instead of every newer message.
 */
export const TRANSCRIPT_PAGE_SIZE = 40;

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

/** Extend the window one page back. `end` never moves, so a prepend is stable. */
export function prependTranscriptWindow(
  window: TranscriptWindow,
  messageCount: number,
): TranscriptWindow {
  return {
    start: Math.max(0, window.start - TRANSCRIPT_PAGE_SIZE),
    end: Math.min(messageCount, window.end),
  };
}

/** Extend the window one page forward. `start` never moves, so an append is stable. */
export function appendTranscriptWindow(
  window: TranscriptWindow,
  messageCount: number,
): TranscriptWindow {
  return {
    start: window.start,
    end: Math.min(messageCount, window.end + TRANSCRIPT_PAGE_SIZE),
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
