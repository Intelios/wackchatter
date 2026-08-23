/**
 * Who actually beat whom.
 *
 * A rating is a summary, and summaries hide things: two contenders can sit twenty points
 * apart having never met, while a third quietly loses every round it plays against one of
 * them and wins enough elsewhere to look level. The matrix is the view that cannot hide
 * that, and a pairwise benchmark is the one kind of history that can produce it.
 *
 * Counted from the same recorded rounds the leaderboard replays, on every render, for the
 * same reason: there is no stored aggregate that could drift away from the rounds behind it.
 *
 * `bad` verdicts are counted but **excluded from the record**, matching `replayRatings`.
 * "Neither of these is usable" says nothing about which is better, so folding it into a win
 * rate would be inventing a comparison the user explicitly declined to make.
 */

import type { ArenaRound } from '@shared/types/arena.ts';

export interface Matchup {
  wins: number;
  losses: number;
  ties: number;
  /** Rounds that carried a comparison. Excludes rejected ones. */
  played: number;
  /** Rounds where both replies were rejected. Recorded, never scored. */
  rejected: number;
}

const EMPTY: Readonly<Matchup> = { wins: 0, losses: 0, ties: 0, played: 0, rejected: 0 };

/** One contender's record against each opponent it has met. */
export type MatchupTable = Map<string, Map<string, Matchup>>;

function cell(table: MatchupTable, from: string, against: string): Matchup {
  let row = table.get(from);
  if (!row) {
    row = new Map();
    table.set(from, row);
  }
  let entry = row.get(against);
  if (!entry) {
    entry = { ...EMPTY };
    row.set(against, entry);
  }
  return entry;
}

/**
 * Build the full matrix. Symmetric by construction — every round is written into both
 * entrants' rows, so `a` vs `b` and `b` vs `a` can never disagree.
 */
export function headToHead(rounds: readonly ArenaRound[]): MatchupTable {
  const table: MatchupTable = new Map();

  for (const round of rounds) {
    const left = round.left.contenderId;
    const right = round.right.contenderId;
    // A contender cannot meaningfully play itself, and pairing never draws such a round.
    if (left === right) continue;

    const forward = cell(table, left, right);
    const back = cell(table, right, left);

    if (round.verdict === 'bad') {
      forward.rejected++;
      back.rejected++;
      continue;
    }

    forward.played++;
    back.played++;

    if (round.verdict === 'tie') {
      forward.ties++;
      back.ties++;
    } else if (round.verdict === 'left') {
      forward.wins++;
      back.losses++;
    } else {
      forward.losses++;
      back.wins++;
    }
  }

  return table;
}

/** The record for one pairing, or an empty one when they have never met. */
export function matchupOf(table: MatchupTable, from: string, against: string): Matchup {
  return table.get(from)?.get(against) ?? { ...EMPTY };
}

/**
 * Win rate as a fraction, counting a tie as half. The ratings themselves treat a tie as a
 * small rise for both sides rather than a half-scored draw — see `TIE_BONUS` in elo.ts — so
 * this is a win-rate summary, not the rating arithmetic. Null when they have never had a
 * scored round together, which is not the same as 0%.
 */
export function winRate(matchup: Matchup): number | null {
  if (matchup.played === 0) return null;
  return (matchup.wins + matchup.ties / 2) / matchup.played;
}

/** Every unordered pair from a set of ids, in a stable order. */
export function allPairings(ids: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (a !== undefined && b !== undefined) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * How many pairings among these entrants have never had a scored round.
 *
 * The number that answers "how much longer until this board means something" — least-played
 * pairing fills these in first, so it falls steadily rather than at random.
 */
export function unplayedPairings(table: MatchupTable, ids: readonly string[]): number {
  return allPairings(ids).filter(([a, b]) => matchupOf(table, a, b).played === 0).length;
}
