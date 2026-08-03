/** How many transcript messages to render initially and load per request. */
export const TRANSCRIPT_PAGE_SIZE = 40;

/** Start index for the newest page of a transcript. */
export function initialTranscriptStart(messageCount: number): number {
  return Math.max(0, messageCount - TRANSCRIPT_PAGE_SIZE);
}

/** Start index after prepending one older page. */
export function prependTranscriptPage(start: number): number {
  return Math.max(0, start - TRANSCRIPT_PAGE_SIZE);
}
