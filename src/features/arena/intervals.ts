/**
 * Confidence intervals for the ratings — the forest plot's whiskers.
 *
 * A bootstrap, the way LMSYS builds its leaderboard bands: resample the recorded rounds
 * with replacement, replay each resample, and read the spread of where the ratings land.
 * Nothing is stored and no ratings table appears — this is one more pure reader of the
 * rounds, exactly like `headToHead`, so a changed `K_FACTOR` re-derives the intervals for
 * free and a deleted round is simply gone from every resample.
 *
 * Only rated rounds are resampled. A `bad` verdict is recorded evidence that *nothing
 * comparative happened*, and giving it resample weight would narrow every interval with
 * information that does not exist.
 *
 * Each resample replays through `applyVerdict` — the one update `replay` itself uses —
 * rather than a second Elo loop, for the same reason `previewVerdict` replays instead of
 * computing: a second body of arithmetic is a disagreement waiting to happen.
 *
 * The generator is seeded from a constant, over the same `createRng` the pairing draw
 * reuses, so the whiskers are identical on every render. An interval that breathed between
 * repaints would read as measurement rather than noise.
 *
 * One property is deliberate, not a defect: the band does **not** shrink toward zero as the
 * history grows. `K_FACTOR` is fixed, so every round can always move a rating and the
 * replay's final rating is a mean-reverting walk that never concentrates — a hundred-round
 * contender retains real endpoint spread, and the whisker reports it. (LMSYS's intervals
 * tighten because they bootstrap an MLE fit; this leaderboard is an online Elo, and lying
 * about its noise would lend false precision to a thirty-point gap.)
 */

import type { ArenaRound } from '@shared/types/arena.ts';
import { createRng } from '@shared/worldinfo/rng.ts';
import { applyVerdict, START_RATING } from './elo.ts';

/**
 * Bootstrap replicates per call.
 *
 * Enough draws that the percentiles are stable round-to-render; cheap enough that the
 * whole walk is single-digit milliseconds for a history in the hundreds of rounds, which
 * is the scale this arena is designed for.
 */
export const BOOTSTRAP_REPS = 300;

/**
 * The seed is a constant rather than an input: the interval is a property of the history,
 * not of when it happened to be computed, and two callers passing different seeds would
 * be two different charts.
 */
const SEED = 'wackchatter arena intervals';

/** The central share to report — 0.95 reads the 2.5th and 97.5th percentiles. */
const CONFIDENCE = 0.95;

export interface RatingInterval {
  contenderId: string;
  /** The low percentile bound, rounded for display like the row rating is. */
  low: number;
  high: number;
}

/**
 * A 95% rating interval for every contender that played a rated round.
 *
 * Contenders absent from the map have not been measured — mirroring the table's rule that
 * an entrant with no rated rounds draws no bar at all.
 */
export function ratingIntervals(rounds: readonly ArenaRound[]): Map<string, RatingInterval> {
  // Chronological, like `replay`'s walk, so a caller that assembled the list itself cannot
  // get a different draw sequence by handing it over in another order.
  const rated = rounds
    .filter((round) => round.verdict !== 'bad')
    .sort((a, b) => a.created - b.created);
  if (rated.length === 0) return new Map();

  const rng = createRng(SEED);
  /** Final rating of each contender, one entry per replicate. */
  const draws = new Map<string, number[]>();

  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    const ratings = new Map<string, { rating: number }>();
    const holder = (id: string) => {
      let state = ratings.get(id);
      if (!state) {
        state = { rating: START_RATING };
        ratings.set(id, state);
      }
      return state;
    };

    for (let draw = 0; draw < rated.length; draw++) {
      const round = rated[Math.floor(rng.next() * rated.length)]!;
      applyVerdict(holder(round.left.contenderId), holder(round.right.contenderId), round.verdict);
    }

    for (const [id, state] of ratings) {
      const list = draws.get(id);
      if (list) list.push(state.rating);
      else draws.set(id, [state.rating]);
    }
  }

  const intervals = new Map<string, RatingInterval>();
  for (const [contenderId, list] of draws) {
    list.sort((a, b) => a - b);
    intervals.set(contenderId, {
      contenderId,
      low: Math.round(percentile(list, (1 - CONFIDENCE) / 2)),
      high: Math.round(percentile(list, 1 - (1 - CONFIDENCE) / 2)),
    });
  }
  return intervals;
}

/** Nearest-rank percentile of an ascending list. `q` is clamped, so `q` of 1 is the last draw. */
function percentile(sorted: readonly number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[index] ?? START_RATING;
}
