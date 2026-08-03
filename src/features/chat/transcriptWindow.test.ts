import { describe, expect, test } from 'bun:test';
import {
  TRANSCRIPT_PAGE_SIZE,
  initialTranscriptStart,
  prependTranscriptPage,
} from './transcriptWindow.ts';

describe('transcript window', () => {
  test('a short transcript renders in full', () => {
    expect(initialTranscriptStart(0)).toBe(0);
    expect(initialTranscriptStart(TRANSCRIPT_PAGE_SIZE)).toBe(0);
  });

  test('a long transcript opens on its newest page', () => {
    expect(initialTranscriptStart(TRANSCRIPT_PAGE_SIZE + 1)).toBe(1);
    expect(initialTranscriptStart(1_000)).toBe(960);
  });

  test('prepending moves back exactly one page without crossing the start', () => {
    expect(prependTranscriptPage(100)).toBe(60);
    expect(prependTranscriptPage(20)).toBe(0);
    expect(prependTranscriptPage(0)).toBe(0);
  });
});
