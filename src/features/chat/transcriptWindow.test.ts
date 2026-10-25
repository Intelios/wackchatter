import { describe, expect, test } from 'bun:test';
import {
  appendTranscriptWindow,
  growTranscriptWindow,
  initialTranscriptWindow,
  prependTranscriptWindow,
  TRANSCRIPT_MAX_MESSAGES,
  TRANSCRIPT_PAGE_SIZE,
  windowForJump,
} from './transcriptWindow.ts';

describe('initialTranscriptWindow', () => {
  test('a short transcript renders in full', () => {
    expect(initialTranscriptWindow(0)).toEqual({ start: 0, end: 0 });
    expect(initialTranscriptWindow(TRANSCRIPT_PAGE_SIZE)).toEqual({
      start: 0,
      end: TRANSCRIPT_PAGE_SIZE,
    });
  });

  test('a long transcript opens on its newest page', () => {
    expect(initialTranscriptWindow(TRANSCRIPT_PAGE_SIZE + 1)).toEqual({
      start: 1,
      end: TRANSCRIPT_PAGE_SIZE + 1,
    });
    expect(initialTranscriptWindow(1_000)).toEqual({ start: 960, end: 1_000 });
  });
});

describe('prepending and appending', () => {
  test('prepending moves back exactly one page without crossing the start', () => {
    const at = { start: 100, end: 140 };
    expect(prependTranscriptWindow(at, 140)).toEqual({ start: 60, end: 140 });
    // A window already at capacity sheds the same distance off the far end.
    expect(prependTranscriptWindow({ start: 20, end: 140 }, 140)).toEqual({
      start: 0,
      end: TRANSCRIPT_MAX_MESSAGES,
    });
    expect(prependTranscriptWindow({ start: 0, end: 140 }, 140)).toEqual({
      start: 0,
      end: TRANSCRIPT_MAX_MESSAGES,
    });
  });

  test('appending moves forward exactly one page without crossing the end', () => {
    const at = { start: 60, end: 100 };
    expect(appendTranscriptWindow(at, 100)).toEqual({ start: 60, end: 100 });
    expect(appendTranscriptWindow({ start: 60, end: 100 }, 250)).toEqual({
      start: 60,
      end: 140,
    });
  });

  test('the window never exceeds the cap, whichever end grows', () => {
    let window = initialTranscriptWindow(5_000);
    for (let page = 0; page < 24; page++) {
      window = prependTranscriptWindow(window, 5_000);
      expect(window.end - window.start).toBeLessThanOrEqual(TRANSCRIPT_MAX_MESSAGES);
    }
    // Twenty-four pages back leaves the reader near the head of a capped window,
    // not holding a thousand mounted rows.
    expect(window).toEqual({
      start: 5_000 - TRANSCRIPT_PAGE_SIZE - 24 * TRANSCRIPT_PAGE_SIZE,
      end: 5_000 - TRANSCRIPT_PAGE_SIZE - 24 * TRANSCRIPT_PAGE_SIZE + TRANSCRIPT_MAX_MESSAGES,
    });
  });

  test("prepending at capacity evicts the newest end, keeping the reader's rows", () => {
    const full = { start: 100, end: 100 + TRANSCRIPT_MAX_MESSAGES };
    const next = prependTranscriptWindow(full, 5_000);
    expect(next).toEqual({
      start: 100 - TRANSCRIPT_PAGE_SIZE,
      end: 100 - TRANSCRIPT_PAGE_SIZE + TRANSCRIPT_MAX_MESSAGES,
    });
  });

  test("appending at capacity evicts the oldest end, keeping the reader's rows", () => {
    const full = { start: 100, end: 100 + TRANSCRIPT_MAX_MESSAGES };
    const next = appendTranscriptWindow(full, 5_000);
    expect(next).toEqual({
      start: 100 + TRANSCRIPT_PAGE_SIZE,
      end: 100 + TRANSCRIPT_MAX_MESSAGES + TRANSCRIPT_PAGE_SIZE,
    });
  });

  test('a partial page at the transcript start still evicts at capacity', () => {
    const full = { start: 10, end: 10 + TRANSCRIPT_MAX_MESSAGES };
    const next = prependTranscriptWindow(full, 5_000);
    expect(next).toEqual({ start: 0, end: TRANSCRIPT_MAX_MESSAGES });
  });
});

describe('growTranscriptWindow', () => {
  test('a tail-anchored window follows new messages', () => {
    expect(growTranscriptWindow({ start: 60, end: 100 }, 101)).toEqual({ start: 60, end: 101 });
  });

  test('growth past the cap evicts the oldest end — a streaming tail stays bounded', () => {
    const grown = growTranscriptWindow(
      { start: 100, end: 100 + TRANSCRIPT_MAX_MESSAGES },
      200 + TRANSCRIPT_MAX_MESSAGES,
    );
    expect(grown).toEqual({ start: 200, end: 200 + TRANSCRIPT_MAX_MESSAGES });
  });

  test('growth shorter than the cap never pulls the start forward', () => {
    expect(growTranscriptWindow({ start: 3, end: 10 }, 20)).toEqual({ start: 3, end: 20 });
  });
});

describe('windowForJump', () => {
  test('a short transcript renders in full wherever you jump', () => {
    expect(windowForJump(0, 10)).toEqual({ start: 0, end: 10 });
    expect(windowForJump(9, 10)).toEqual({ start: 0, end: 10 });
  });

  test('a target in the middle centres a single page on it', () => {
    const win = windowForJump(50, 1_000);
    expect(win.start).toBeLessThanOrEqual(50);
    expect(win.end).toBeGreaterThan(50);
    expect(win.end - win.start).toBeLessThanOrEqual(TRANSCRIPT_PAGE_SIZE);
  });

  test('a target near the start lands on the first page', () => {
    expect(windowForJump(0, 1_000)).toEqual({ start: 0, end: TRANSCRIPT_PAGE_SIZE });
  });

  test('a target in the last page anchors to the tail', () => {
    const win = windowForJump(999, 1_000);
    expect(win.end).toBe(1_000);
    expect(win.start).toBe(1_000 - TRANSCRIPT_PAGE_SIZE);
  });

  test('an out-of-range target clamps rather than producing an empty window', () => {
    expect(windowForJump(5_000, 1_000)).toEqual({ start: 960, end: 1_000 });
    expect(windowForJump(-4, 1_000)).toEqual({ start: 0, end: TRANSCRIPT_PAGE_SIZE });
  });
});
