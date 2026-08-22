/**
 * The leaderboard, replayed from the recorded rounds.
 *
 * There is no ratings table and nothing is incrementally updated. Every read walks the
 * whole history in order and recomputes, which buys three things worth more than the
 * arithmetic it costs:
 *
 *  - A rating cannot drift from the rounds behind it. There is no second copy to disagree.
 *  - `K_FACTOR` and `PROVISIONAL_ROUNDS` can change and all history recomputes to match,
 *    rather than leaving every rating a fossil of the constant in force when it was earned.
 *  - Deleting one bad round is a delete, not a compensating adjustment.
 *
 * Same reasoning Stats gives for counting in SQL per request rather than keeping a stats
 * table. A personal benchmark measures in hundreds of rounds; this is not the hot path.
 */

import type { ArenaRound, Contender } from '@shared/types/arena.ts';

/** Everyone starts level. */
export const START_RATING = 1500;

/**
 * How far one round can move a rating.
 *
 * 32 is chess's provisional K, and high for a rating system — deliberately. This history
 * is tens of rounds, not thousands: a K tuned for a tournament career would leave a
 * twenty-round benchmark showing everyone at 1500 and tell the user nothing.
 */
export const K_FACTOR = 32;

/** Below this many rated rounds a rating is noise, and is labelled as such. */
export const PROVISIONAL_ROUNDS = 10;

export interface LeaderboardRow {
  contenderId: string;
  /**
   * The model and provider most recently seen for this contender. Facts recorded on the
   * round, not display names — they are what the UI falls back to when the contender has
   * since been deleted from the pool, so a round never drops out of its own history.
   * Empty for a pool entry that has not fought yet.
   */
  model: string;
  provider: string;
  /** Rounded for display; the replay itself keeps full precision. */
  rating: number;
  /** Rounds that moved the rating. Excludes rejected ones. */
  rounds: number;
  wins: number;
  losses: number;
  ties: number;
  /**
   * Rounds where the user rejected both replies. Recorded, never rated — see `replayRatings`.
   */
  rejected: number;
  provisional: boolean;
}

/** One contender's rating after `index` rounds have been judged. */
export interface RatingPoint {
  /** How many rounds of the whole history are behind this point. 0 is before any. */
  index: number;
  rating: number;
  /** What the round at this index did to it. 0 when it did not play, or on a `bad` verdict. */
  delta: number;
}

/**
 * One contender's rating over the whole history.
 *
 * Every series covers every round, not only the ones this contender fought — a flat stretch
 * is a real thing to see on a chart ("it sat out while those two slugged it out"), and lines
 * of different lengths could not be read against one another.
 */
export interface RatingSeries {
  contenderId: string;
  model: string;
  points: RatingPoint[];
}

export interface Replay {
  rows: LeaderboardRow[];
  series: RatingSeries[];
  /** The rounds in the order they were replayed — the chart's x axis. */
  ordered: ArenaRound[];
}

interface Tally {
  rating: number;
  /** Rating after each round so far, oldest first. Index 0 is before anything was played. */
  points: RatingPoint[];
  model: string;
  provider: string;
  rounds: number;
  wins: number;
  losses: number;
  ties: number;
  rejected: number;
}

function expectedScore(rating: number, against: number): number {
  return 1 / (1 + 10 ** ((against - rating) / 400));
}

/**
 * Replay every round into a leaderboard.
 *
 * `contenders` seeds a row for each pool entry so an entrant that has not fought yet still
 * appears, at the starting rating with nothing behind it. Ids seen only in rounds get rows
 * too — a contender deleted from the pool keeps its history rather than silently taking
 * its rounds' meaning with it.
 *
 * **A `bad` verdict moves no ratings.** "Neither of these is worth using" is not "these two
 * are equal": the two can fail for unrelated reasons, and scoring it as a draw would drag a
 * strong rating toward a weak one on evidence that contains no comparison at all. It is
 * counted instead, which is the number that actually answers "does anything handle this
 * card?" — and it means the user can reject a round honestly without corrupting the board.
 */
export function replay(
  rounds: readonly ArenaRound[],
  contenders: readonly Contender[] = [],
): Replay {
  const tallies = new Map<string, Tally>();

  // Chronological, because Elo is path-dependent: the same rounds in another order give
  // different ratings. The store's index exists for exactly this read, but it is sorted
  // again here so a caller that assembled the list itself cannot get it subtly wrong.
  const ordered = [...rounds].sort((a, b) => a.created - b.created);

  /** How many rounds have been folded in. Also the index of the point being built. */
  let played = 0;

  const tally = (id: string): Tally => {
    let entry = tallies.get(id);
    if (!entry) {
      entry = {
        rating: START_RATING,
        // Backfilled to the current position at the starting rating. A contender that first
        // appears at round thirty really was unrated for the first twenty-nine, and a series
        // that began late could not be read against the ones beside it.
        points: Array.from({ length: played + 1 }, (_, index) => ({
          index,
          rating: START_RATING,
          delta: 0,
        })),
        model: '',
        provider: '',
        rounds: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        rejected: 0,
      };
      tallies.set(id, entry);
    }
    return entry;
  };

  for (const contender of contenders) tally(contender.id);

  for (const round of ordered) {
    const left = tally(round.left.contenderId);
    const right = tally(round.right.contenderId);

    // Last seen wins: a contender repointed at a new model should be labelled with the one
    // it is running now, while a deleted one keeps whatever it last ran.
    left.model = round.left.model;
    left.provider = round.left.provider;
    right.model = round.right.model;
    right.provider = round.right.provider;

    const before = new Map([...tallies].map(([id, entry]) => [id, entry.rating]));

    if (round.verdict === 'bad') {
      left.rejected++;
      right.rejected++;
      played++;
      // Still a point on every line: the x axis counts rounds judged, and a rejected round
      // took the same time and money as any other. It simply moves nothing.
      recordPoints(tallies, before, played);
      continue;
    }

    const leftScore = round.verdict === 'left' ? 1 : round.verdict === 'right' ? 0 : 0.5;

    // Both expectations are computed from the pre-round ratings, or whichever side updated
    // first would be answering a question the other one already changed.
    const leftExpected = expectedScore(left.rating, right.rating);
    const rightExpected = expectedScore(right.rating, left.rating);

    left.rating += K_FACTOR * (leftScore - leftExpected);
    right.rating += K_FACTOR * (1 - leftScore - rightExpected);

    left.rounds++;
    right.rounds++;

    if (round.verdict === 'tie') {
      left.ties++;
      right.ties++;
    } else if (round.verdict === 'left') {
      left.wins++;
      right.losses++;
    } else {
      left.losses++;
      right.wins++;
    }

    played++;
    recordPoints(tallies, before, played);
  }

  const rows: LeaderboardRow[] = [...tallies.entries()].map(([contenderId, entry]) => ({
    contenderId,
    model: entry.model,
    provider: entry.provider,
    // Rounded once, at the end. Rounding each update would accumulate drift and make the
    // result depend on how the history happened to be split.
    rating: Math.round(entry.rating),
    rounds: entry.rounds,
    wins: entry.wins,
    losses: entry.losses,
    ties: entry.ties,
    rejected: entry.rejected,
    provisional: entry.rounds < PROVISIONAL_ROUNDS,
  }));

  /*
   * Established ratings rank above provisional ones, then by rating.
   *
   * Sorting on rating alone would let one lucky win put a two-round entrant above a model
   * with forty rounds behind it — technically its rating, but read as a ranking it is a
   * lie, and the row's own marker is not enough to stop someone reading down the list.
   * Chess ranks provisional ratings separately for the same reason.
   */
  rows.sort((a, b) => {
    if (a.provisional !== b.provisional) return a.provisional ? 1 : -1;
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (b.rounds !== a.rounds) return b.rounds - a.rounds;
    return a.contenderId.localeCompare(b.contenderId);
  });

  // Series follow the table's order, so the chart's legend and the rows beneath it read
  // top-to-bottom the same way.
  const series: RatingSeries[] = rows.map((row) => ({
    contenderId: row.contenderId,
    model: row.model,
    points: tallies.get(row.contenderId)?.points ?? [],
  }));

  return { rows, series, ordered };
}

/**
 * Append this round's point to every contender's line.
 *
 * `before` holds the ratings as they were, so a contender that did not play records a delta
 * of zero rather than a difference against a rating that moved for some other reason.
 */
function recordPoints(
  tallies: Map<string, Tally>,
  before: Map<string, number>,
  index: number,
): void {
  for (const [id, entry] of tallies) {
    const previous = before.get(id) ?? START_RATING;
    entry.points.push({
      index,
      // Rounded for display like the row is, and for the same reason: the running value
      // keeps full precision, so the chart cannot drift away from the table.
      rating: Math.round(entry.rating),
      /*
       * The difference between the DISPLAYED ratings, not the rounded difference of the
       * real ones — so the number shown always reconciles with the two numbers either side
       * of it. The cost is that a round's two deltas can read as -19 and +20 where the
       * underlying swing was ±19.5 either way. Zero-sum still holds on the real values; it
       * is the integers on screen that cannot both be right.
       */
      delta: Math.round(entry.rating) - Math.round(previous),
    });
  }
}

/** The leaderboard alone, for callers with no chart to draw. */
export function replayRatings(
  rounds: readonly ArenaRound[],
  contenders: readonly Contender[] = [],
): LeaderboardRow[] {
  return replay(rounds, contenders).rows;
}

/** What one contender's rating did, either side of a round. */
export interface RatingMove {
  before: number;
  after: number;
  delta: number;
}

export interface VerdictPreview {
  left: RatingMove;
  right: RatingMove;
}

/**
 * What a verdict would do to the two ratings, before the round has been recorded.
 *
 * The reveal has to show this immediately — you have just paid for two generations and the
 * one thing you want back is what they bought — but the round is not in the history until
 * its POST lands. So the answer is computed by replaying the history **with the round
 * appended**, through the same `replay` every other number on the board comes from.
 *
 * Deliberately not a second Elo loop. A local `K_FACTOR * (score - expected)` here would be
 * a fourth-decimal-place disagreement waiting to happen with the leaderboard, which is the
 * exact failure the no-ratings-table rule exists to prevent.
 */
export function previewVerdict(
  rounds: readonly ArenaRound[],
  contenders: readonly Contender[],
  next: Pick<ArenaRound, 'characterId' | 'probe' | 'left' | 'right' | 'verdict'>,
): VerdictPreview {
  // Sorted last whatever the clock says: `replay` orders by `created`, and a machine whose
  // time has slipped backwards must not have its newest round folded in halfway.
  const latest = rounds.reduce((max, round) => Math.max(max, round.created), 0);
  const synthetic: ArenaRound = {
    ...next,
    id: 'preview',
    created: latest + 1,
  };

  const { series } = replay([...rounds, synthetic], contenders);
  const move = (contenderId: string): RatingMove => {
    const points = series.find((entry) => entry.contenderId === contenderId)?.points ?? [];
    const last = points[points.length - 1];
    if (!last) return { before: START_RATING, after: START_RATING, delta: 0 };
    return { before: last.rating - last.delta, after: last.rating, delta: last.delta };
  };

  return {
    left: move(next.left.contenderId),
    right: move(next.right.contenderId),
  };
}
