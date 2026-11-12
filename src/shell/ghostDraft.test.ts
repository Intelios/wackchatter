import { describe, expect, test } from 'bun:test';
import {
  GHOST_IDLES,
  type GhostIdle,
  type GhostMetrics,
  ghostLayout,
  ghostTokens,
  nextIdle,
  scribblePoints,
  seededRandom,
} from './ghostDraft.ts';

const metrics: GhostMetrics = {
  lineHeight: 26,
  paragraphGap: 14,
  space: 4,
  measure: (text) => text.length * 8,
};

describe('ghostTokens', () => {
  test('tells speech, action and narration apart, and strips the markers', () => {
    const tokens = ghostTokens('*She nods.* "Come in," she says.', true);
    expect(tokens.map((t) => [t.text, t.voice])).toEqual([
      ['She', 'action'],
      ['nods.', 'action'],
      ['"Come', 'speech'],
      ['in,"', 'speech'],
      ['she', 'plain'],
      ['says.', 'plain'],
    ]);
  });

  test('marks sentence ends, through a closing quote', () => {
    const tokens = ghostTokens('"Wait." Then nothing', true);
    expect(tokens.map((t) => t.sentenceEnd)).toEqual([true, false, false]);
  });

  test('a blank line is a paragraph, a single newline a line break', () => {
    const tokens = ghostTokens('One\ntwo\n\nthree', true);
    expect(tokens.map((t) => t.breakBefore)).toEqual(['none', 'line', 'paragraph']);
  });

  test('holds back the word still arriving until it is whole', () => {
    expect(ghostTokens('The lamp ro', false).map((t) => t.text)).toEqual(['The', 'lamp']);
    expect(ghostTokens('The lamp ro', true).map((t) => t.text)).toEqual(['The', 'lamp', 'ro']);
    expect(ghostTokens('The lamp room ', false)).toHaveLength(3);
  });

  test('a word made only of markers is nothing to draw', () => {
    expect(ghostTokens('One\n\n***\n\n# Two', true).map((t) => t.text)).toEqual(['One', 'Two']);
  });
});

describe('ghostLayout', () => {
  test('wraps at the width and opens a gap between paragraphs', () => {
    const { words, height } = ghostLayout(ghostTokens('aaaa bbbb cccc\n\ndd', true), 80, metrics);
    expect(words.map((w) => [w.x, w.y])).toEqual([
      [0, 0],
      [36, 0],
      [0, 26],
      [0, 66],
    ]);
    expect(height).toBe(92);
  });

  test('adding words never moves a word already placed', () => {
    const text = 'The fog swallows the last of the harbour lights. "Until tonight," she says.';
    const whole = ghostLayout(ghostTokens(text, true), 120, metrics).words;
    for (let cut = 1; cut < text.length; cut++) {
      const partial = ghostLayout(ghostTokens(text.slice(0, cut), false), 120, metrics).words;
      for (const [i, word] of partial.entries()) {
        expect([word.x, word.y, word.width]).toEqual([whole[i]!.x, whole[i]!.y, whole[i]!.width]);
      }
    }
  });

  test('an empty reply is still one line tall', () => {
    expect(ghostLayout([], 300, metrics).height).toBe(26);
  });
});

describe('scribblePoints', () => {
  test('is the same for the same seed, and runs baseline to baseline across the word', () => {
    const a = scribblePoints(7, 56, 42);
    expect(scribblePoints(7, 56, 42)).toEqual(a);
    expect(scribblePoints(7, 56, 43)).not.toEqual(a);
    expect(a[0]![0]).toBeCloseTo(0);
    expect(a[0]![1]).toBeCloseTo(0);
    expect(a[a.length - 1]![0]).toBeCloseTo(56);
    expect(a[a.length - 1]![1]).toBeCloseTo(0);
    expect(Math.max(...a.map((p) => p[1]))).toBeLessThanOrEqual(1e-9);
  });
});

describe('nextIdle', () => {
  test('never plays the same idle twice running', () => {
    const random = seededRandom(7);
    let previous: GhostIdle | null = null;
    const seen = new Set<GhostIdle>();
    for (let i = 0; i < 200; i++) {
      const idle = nextIdle(previous, random);
      expect(idle).not.toBe(previous);
      seen.add(idle);
      previous = idle;
    }
    expect([...seen].sort()).toEqual([...GHOST_IDLES].sort());
  });
});
