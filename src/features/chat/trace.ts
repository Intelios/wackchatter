/**
 * A reply's timeline, measured as it happens and settled into the small `ReplyTrace` its
 * swipe keeps. Pure apart from the clock the caller reads, so the rules are tested here.
 */

import type { StreamUsage } from '@shared/providers/sse.ts';
import type { ReplyTrace } from '@shared/types/chat.ts';

/** Clock readings (`performance.now()`), taken by the generation as it goes. */
export interface TraceMarks {
  start: number;
  lore?: { ms: number; fired: number };
  memory?: { ms: number; recalled: number };
  /** The request went out. Unset when it never did. */
  sent?: number;
  thinking?: number;
  writing?: number;
}

/**
 * Whether a frame of the stream is the first thinking or the first text, noted on `marks`.
 * `seed` is what a continue started from: text only counts once it grows past it.
 */
export function markStream(
  marks: TraceMarks,
  now: number,
  frame: { content: string; reasoning: string },
  seed: string,
): void {
  if (marks.thinking === undefined && marks.writing === undefined && frame.reasoning) {
    marks.thinking = now;
  }
  if (marks.writing === undefined && frame.content !== seed && frame.content.length) {
    marks.writing = now;
  }
}

/** The trace a swipe keeps, in whole milliseconds from the start. */
export function settleTrace(
  marks: TraceMarks,
  now: number,
  outcome: ReplyTrace['outcome'],
  usage?: StreamUsage,
): ReplyTrace {
  const at = (time: number) => Math.max(0, Math.round(time - marks.start));
  const end = at(now);
  return {
    sent: marks.sent === undefined ? end : at(marks.sent),
    ...(marks.lore ? { lore: { ms: Math.round(marks.lore.ms), fired: marks.lore.fired } } : {}),
    ...(marks.memory
      ? { memory: { ms: Math.round(marks.memory.ms), recalled: marks.memory.recalled } }
      : {}),
    ...(marks.thinking !== undefined ? { thinking: at(marks.thinking) } : {}),
    ...(marks.writing !== undefined ? { writing: at(marks.writing) } : {}),
    end,
    outcome,
    ...(typeof usage?.reasoning_tokens === 'number' && usage.reasoning_tokens > 0
      ? { thinkingTokens: usage.reasoning_tokens }
      : {}),
    ...(typeof usage?.cached_tokens === 'number' && usage.cached_tokens > 0
      ? { cachedTokens: usage.cached_tokens }
      : {}),
  };
}
