/**
 * The ghost draft: the shape of a reply that is being written out of sight.
 *
 * With Streaming off the reply's text stays hidden until it is whole. This turns that hidden
 * text into what the nib may show of it — how long each word is, whose voice it is in, where
 * sentences and paragraphs end — and lays those words out the way the text will wrap, so the
 * scribbles grow to roughly the height the reply will have. No letter leaves this module:
 * a token keeps its text only so the layout can measure it.
 *
 * Pure, so it runs without a DOM; `GhostDraft.tsx` does the drawing.
 */

import { inkSegments } from './ink.ts';

export type GhostVoice = 'plain' | 'speech' | 'action';
export type GhostBreak = 'none' | 'line' | 'paragraph';

export interface GhostToken {
  /** The word without its markdown markers. Measured, never drawn. */
  text: string;
  voice: GhostVoice;
  sentenceEnd: boolean;
  /** What separates this word from the one before it. */
  breakBefore: GhostBreak;
}

export interface GhostWord extends GhostToken {
  x: number;
  /** Top of the word's line. */
  y: number;
  width: number;
}

export interface GhostMetrics {
  lineHeight: number;
  paragraphGap: number;
  space: number;
  measure(text: string): number;
}

const MARKERS = /[*`#>]/g;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/**
 * Words of the reply so far. While it is still arriving (`complete` false) the last word is
 * left out until whitespace follows it, so a word never changes length once it has been inked.
 */
export function ghostTokens(text: string, complete: boolean): GhostToken[] {
  const tokens: GhostToken[] = [];
  let word = '';
  let voice: GhostVoice = 'plain';
  let newlines = 0;
  let pending: GhostBreak = 'none';

  const flush = () => {
    const clean = word.replace(MARKERS, '');
    if (clean) {
      tokens.push({
        text: clean,
        voice,
        sentenceEnd: SENTENCE_END.test(clean),
        breakBefore: tokens.length ? pending : 'none',
      });
      pending = 'none';
    }
    word = '';
    voice = 'plain';
  };

  for (const segment of inkSegments(text)) {
    const kind: GhostVoice =
      segment.kind === 'say' ? 'speech' : segment.kind === 'act' ? 'action' : 'plain';
    for (const ch of segment.text) {
      if (/\s/.test(ch)) {
        if (word) flush();
        if (ch === '\n') {
          newlines++;
          const next: GhostBreak = newlines >= 2 ? 'paragraph' : 'line';
          if (pending !== 'paragraph') pending = next;
        }
        continue;
      }
      newlines = 0;
      word += ch;
      if (kind === 'speech' || (kind === 'action' && voice === 'plain')) voice = kind;
    }
  }
  if (word && complete) flush();
  return tokens;
}

/**
 * Wrap the words into lines. Greedy, like the text itself, so adding words to the end never
 * moves a word that is already placed.
 */
export function ghostLayout(
  tokens: readonly GhostToken[],
  width: number,
  metrics: GhostMetrics,
): { words: GhostWord[]; height: number } {
  const words: GhostWord[] = [];
  let x = 0;
  let y = 0;
  for (const token of tokens) {
    const w = metrics.measure(token.text);
    if (token.breakBefore === 'paragraph') {
      x = 0;
      y += metrics.lineHeight + metrics.paragraphGap;
    } else if (token.breakBefore === 'line' || (x > 0 && x + w > width)) {
      x = 0;
      y += metrics.lineHeight;
    }
    words.push({ ...token, x, y, width: w });
    x += w + metrics.space;
  }
  return { words, height: y + metrics.lineHeight };
}

/** A small seeded generator (mulberry32), so a word's scribble is the same on every frame. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One word as cursive loops: points from its left edge, y up from the baseline (negative is
 * up). It starts and ends on the baseline, so a partly drawn word is a prefix of the points.
 */
export function scribblePoints(length: number, width: number, seed: number): [number, number][] {
  const random = seededRandom(seed);
  const humps = Math.max(1, Math.round(length * 0.85));
  const heights: number[] = [];
  for (let k = 0; k < humps; k++) heights.push(random() < 0.24 ? 5.3 : 2.5 + random() * 1.3);
  const steps = humps * 12;
  const loop = Math.min(2.3, width / (humps * 2.6));
  const points: [number, number][] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const angle = t * humps * 2 * Math.PI;
    const height = heights[Math.min(humps - 1, Math.floor(t * humps))] ?? 3;
    points.push([t * width - loop * Math.sin(angle), -height * (1 - Math.cos(angle))]);
  }
  return points;
}

/** What the nib does when the stream stalls. Each starts and ends in the same rest pose. */
export const GHOST_IDLES = ['dip', 'tap', 'cross'] as const;
export type GhostIdle = (typeof GHOST_IDLES)[number];

/** The next idle: any but the one just played. */
export function nextIdle(previous: GhostIdle | null, random: () => number): GhostIdle {
  const pool = GHOST_IDLES.filter((idle) => idle !== previous);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? 'tap';
}
