import { describe, expect, test } from 'bun:test';
import {
  appendTranscriptWindow,
  initialTranscriptWindow,
  prependTranscriptWindow,
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
    expect(prependTranscriptWindow({ start: 20, end: 140 }, 140)).toEqual({
      start: 0,
      end: 140,
    });
    expect(prependTranscriptWindow({ start: 0, end: 140 }, 140)).toEqual({ start: 0, end: 140 });
  });

  test('appending moves forward exactly one page without crossing the end', () => {
    const at = { start: 60, end: 100 };
    expect(appendTranscriptWindow(at, 100)).toEqual({ start: 60, end: 100 });
    expect(appendTranscriptWindow({ start: 60, end: 100 }, 250)).toEqual({
      start: 60,
      end: 140,
    });
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
