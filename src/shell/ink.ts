/**
 * Live ink: how the draft in the composer is coloured while you type, so it already looks
 * the way the chat will show it.
 *
 * Colour only, by design. The ink is a mirror drawn under a transparent textarea, and the
 * two only line up glyph for glyph if nothing changes a glyph's width: no bold, no italics,
 * no hidden characters. Every character of the draft appears in exactly one segment.
 */

import { dialogueRanges, markdownEligibility } from '../features/chat/dialogue.ts';

export type InkKind = 'plain' | 'say' | 'act' | 'code' | 'macro' | 'command';

export interface InkSegment {
  text: string;
  kind: InkKind;
}

const RANK: Record<InkKind, number> = {
  plain: 0,
  act: 1,
  say: 2,
  code: 3,
  macro: 4,
  command: 5,
};

export function inkSegments(text: string): InkSegment[] {
  if (!text) return [];
  const kinds: InkKind[] = new Array(text.length).fill('plain');
  const paint = (start: number, end: number, kind: InkKind) => {
    for (let i = start; i < end; i++) {
      if (RANK[kind] > RANK[kinds[i]!]) kinds[i] = kind;
    }
  };

  // *actions*, a pair on one line; an unclosed one runs to the end of its line, since that
  // is the one being typed.
  const lines = lineSpans(text);
  for (const [lineStart, lineEnd] of lines) {
    let open = -1;
    for (let i = lineStart; i < lineEnd; i++) {
      if (text[i] !== '*') continue;
      if (open < 0) open = i;
      else {
        paint(open, i + 1, 'act');
        open = -1;
      }
    }
    if (open >= 0) paint(open, lineEnd, 'act');
  }

  // "Speech", the same pairs the transcript colours, plus the one still being typed.
  const ranges = dialogueRanges(text);
  for (const range of ranges) paint(range.start, range.end, 'say');
  const lastLine = lines[lines.length - 1]!;
  const closedOnLast = ranges.filter((r) => r.start >= lastLine[0]);
  const lastClose = closedOnLast.length ? closedOnLast[closedOnLast.length - 1]!.end : lastLine[0];
  const trailingOpen = findOpenQuote(text, lastClose, lastLine[1]);
  if (trailingOpen >= 0) paint(trailingOpen, lastLine[1], 'say');

  // Code wins over speech and actions inside it, as it does in the transcript.
  const eligible = markdownEligibility(text);
  let codeStart = -1;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !eligible[i]) {
      if (codeStart < 0) codeStart = i;
    } else if (codeStart >= 0) {
      paint(codeStart, i, 'code');
      codeStart = -1;
    }
  }

  // {{macros}}
  for (const match of text.matchAll(/\{\{[^{}\n]*\}\}/g)) {
    paint(match.index, match.index + match[0].length, 'macro');
  }

  // A leading /command name.
  const command = /^\/\w*/.exec(text);
  if (command) paint(0, command[0].length, 'command');

  const segments: InkSegment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || kinds[i] !== kinds[start]) {
      segments.push({ text: text.slice(start, i), kind: kinds[start]! });
      start = i;
    }
  }
  return segments;
}

function lineSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  return spans;
}

function findOpenQuote(text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    if (text[i] === '"' || text[i] === '“') return i;
  }
  return -1;
}
