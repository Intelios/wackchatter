/**
 * Reading one run as a comparison rather than as N independent replies.
 *
 * The metrics were always there — the footer printed "4.2s to first · 18.7s total · 612 tok"
 * under each column and left the subtraction to the reader. On a screen whose entire purpose
 * is a comparison, that is the one job the layout should not be delegating.
 */

import type { ColumnLeaders } from './ContenderColumn.tsx';
import type { RunEntry } from './state/arenaReducer.ts';

/**
 * Compare at the precision the figure is DISPLAYED at, never the precision it was measured
 * at.
 *
 * The tape prints seconds to one decimal place, so 118ms and 143ms both read "0.1s" — and
 * marking one of those as the winner puts a lime 0.1s beside a plain 0.1s, which reads as a
 * rendering fault rather than as a result. The same rule the leaderboard already follows for
 * rating deltas: what is on screen has to reconcile with what is beside it.
 */
function best(
  entries: readonly RunEntry[],
  measure: (entry: RunEntry) => number | null,
  /** Raw value to the integer the display rounds it to. */
  displayed: (value: number) => number,
  better: (candidate: number, incumbent: number) => boolean,
): string | undefined {
  let leader: { id: string; value: number } | null = null;
  let tied = false;

  for (const entry of entries) {
    const raw = measure(entry);
    if (raw === null || !Number.isFinite(raw)) continue;
    const value = displayed(raw);
    if (!leader) {
      leader = { id: entry.contenderId, value };
      continue;
    }
    if (better(value, leader.value)) {
      leader = { id: entry.contenderId, value };
      tied = false;
    } else if (value === leader.value) {
      tied = true;
    }
  }

  // A dead heat has no winner. Marking one of two identical figures would be picking the
  // one that happened to be on the left.
  return leader && !tied ? leader.id : undefined;
}

/** Milliseconds as the tape shows them: seconds to one decimal place. */
const asSeconds = (ms: number): number => Math.round(ms / 100);
/** Tokens per second as the tape shows them: one decimal place. */
const asRate = (rate: number): number => Math.round(rate * 10);

const lower = (candidate: number, incumbent: number): boolean => candidate < incumbent;
const higher = (candidate: number, incumbent: number): boolean => candidate > incumbent;

/**
 * Who won each measure in this run.
 *
 * Only ever meaningful with two or more settled columns, and returns nothing at all below
 * that — a single column "winning" every figure is noise dressed as a result.
 */
export function columnLeaders(entries: readonly RunEntry[]): ColumnLeaders {
  const settled = entries.filter((entry) => entry.status === 'done');
  if (settled.length < 2) return {};

  return {
    firstToken: best(settled, (entry) => entry.firstTokenMs, asSeconds, lower),
    total: best(settled, (entry) => entry.elapsedMs, asSeconds, lower),
    rate: best(
      settled,
      (entry) =>
        entry.completionTokens !== null && entry.elapsedMs
          ? (entry.completionTokens / entry.elapsedMs) * 1000
          : null,
      asRate,
      higher,
    ),
  };
}

/**
 * Each reply's length as a fraction of the longest in the run.
 *
 * Characters, not tokens: `completionTokens` is frequently our own estimate and is missing
 * entirely for a provider that reports no usage, so a bar drawn from it would compare a
 * measured column against an estimated one. Characters are available for every column by
 * construction, which is what makes the bars comparable at all.
 */
export function lengthRatios(entries: readonly RunEntry[]): Map<string, number> {
  const longest = entries.reduce((max, entry) => Math.max(max, entry.text.length), 0);
  return new Map(
    entries.map((entry) => [entry.contenderId, longest === 0 ? 0 : entry.text.length / longest]),
  );
}
