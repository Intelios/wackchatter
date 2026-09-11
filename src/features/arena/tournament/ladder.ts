/**
 * The career tournament ladder.
 *
 * A contender earns points for every match it wins, weighted by how deep in the bracket the
 * win came — the first round is worth 1, and each stage doubles it. A loss costs nothing at
 * all. That is the whole reason this is not Elo: a rating has to move on a loss to stay an
 * estimate of strength, but a *tournament* result is a record of what was achieved, and a
 * semi-finalist who lost to the eventual champion achieved a great deal. Here they simply
 * stop climbing; they are never demoted.
 *
 * There is no standings table. Every row is replayed from the stored matches on render, so
 * the ladder cannot drift from the evidence and a stage's weight can change without
 * invalidating anything — the same contract the leaderboard has with `arena_rounds`.
 *
 * Retired contenders keep their points: a match names the endpoint that fought it, and
 * deleting a pool row must not rewrite a tournament someone already played. The model and
 * provider recorded on the match are the fallback label once the contender is gone.
 */

import type { Contender, TournamentWithMatches } from '@shared/types/arena.ts';
import { tournamentStagePoints } from '@shared/types/arena.ts';
import { bracketView, loserIdOf, winnerIdOf } from './bracket.ts';

/** One tournament's contribution to a contender's total, for the expandable rows. */
export interface LadderTournamentPoints {
  tournamentId: string;
  points: number;
  /** Wins in that tournament, so an expansion can show "2 wins · 3 pts". */
  wins: number;
}

export interface LadderRow {
  contenderId: string;
  points: number;
  wins: number;
  losses: number;
  /** Tournaments entered. Counts a tournament you were seeded into even if you lost at once. */
  tournaments: number;
  /** Brackets won. */
  titles: number;
  /** The model and provider last seen for this contender, for when the pool row is gone. */
  model: string;
  provider: string;
  /** Deepest stage (0-based) in which this contender won. Null when it never won. */
  bestStage: number | null;
  /** The earliest win's timestamp, the second tiebreak. Infinity when it never won. */
  firstWinAt: number;
  /** Tournaments won, in creation order. */
  titleIds: string[];
  /** Where the points came from, one entry per tournament that gave any. */
  byTournament: LadderTournamentPoints[];
}

interface MutableRow extends LadderRow {
  byTournamentPoints: Map<string, LadderTournamentPoints>;
  /** When the model/provider were last refreshed, so a replay keeps the newest facts. */
  seenAt: number;
}

/** One decided match, resolved to what the ladder needs for both sides. */
interface DecisiveMatch {
  tournamentId: string;
  winnerId: string;
  loserId: string;
  stage: number;
  created: number;
  points: number;
  winnerModel: string;
  winnerProvider: string;
  loserModel: string;
  loserProvider: string;
}

/** One tournament's contribution: who won it, and the matches that got them there. */
interface DecidedTournament {
  tournamentId: string;
  championId: string | null;
  entrants: readonly string[];
  matches: DecisiveMatch[];
}

function newRow(contenderId: string): MutableRow {
  return {
    contenderId,
    points: 0,
    wins: 0,
    losses: 0,
    tournaments: 0,
    titles: 0,
    model: '',
    provider: '',
    bestStage: null,
    firstWinAt: Number.POSITIVE_INFINITY,
    titleIds: [],
    byTournament: [],
    byTournamentPoints: new Map(),
    seenAt: Number.NEGATIVE_INFINITY,
  };
}

/**
 * Replay every tournament into a career ladder.
 *
 * Pool contenders are seeded at zero so an entrant that has not played yet is visible at the
 * bottom rather than absent, the same way the leaderboard shows an unfought contender at its
 * starting rating. Ids seen only in matches keep a row too, which is what lets a retired
 * contender hold its place.
 */
export function tournamentLadder(
  tournaments: readonly TournamentWithMatches[],
  contenders: readonly Contender[],
): LadderRow[] {
  const rows = new Map<string, MutableRow>();
  const rowFor = (id: string): MutableRow => {
    let row = rows.get(id);
    if (!row) {
      row = newRow(id);
      rows.set(id, row);
    }
    return row;
  };

  for (const contender of contenders) rowFor(contender.id);

  /*
   * The decisive matches, flattened once in creation order.
   *
   * Taken from `bracketView` rather than `tournament.matches` so a row that cannot be placed
   * in a slot (a hand-edited database, a match for a stage that no longer exists) cannot
   * score. The same walk the bracket draws is the one that pays out, and each tournament is
   * walked exactly once — here — so the walk cannot disagree with itself either.
   */
  const decided: DecidedTournament[] = tournaments.map((tournament) => {
    const view = bracketView(tournament);
    const matches: DecisiveMatch[] = [];

    for (const row of view.stages) {
      for (const slot of row) {
        const match = slot.match;
        if (!match) continue;
        const winnerId = winnerIdOf(match);
        const loserId = loserIdOf(match);
        matches.push({
          tournamentId: tournament.id,
          winnerId,
          loserId,
          stage: match.stage,
          created: match.created,
          points: tournamentStagePoints(match.stage),
          winnerModel: match.left.contenderId === winnerId ? match.left.model : match.right.model,
          winnerProvider:
            match.left.contenderId === winnerId ? match.left.provider : match.right.provider,
          loserModel: match.left.contenderId === loserId ? match.left.model : match.right.model,
          loserProvider:
            match.left.contenderId === loserId ? match.left.provider : match.right.provider,
        });
      }
    }

    return {
      tournamentId: tournament.id,
      championId: view.championId,
      entrants: tournament.entrants,
      matches,
    };
  });

  const decisive = decided.flatMap((entry) => entry.matches);

  for (const tournament of decided) {
    // Entering is a fact about the plan, not about the matches, so it is counted from the
    // definition — a contender knocked out in round one still entered the tournament.
    for (const id of new Set(tournament.entrants)) rowFor(id).tournaments++;

    if (tournament.championId) {
      const champion = rowFor(tournament.championId);
      champion.titles++;
      champion.titleIds.push(tournament.tournamentId);
    }

    for (const match of tournament.matches) {
      const winner = rowFor(match.winnerId);
      winner.points += match.points;
      winner.wins++;
      winner.bestStage =
        winner.bestStage === null ? match.stage : Math.max(winner.bestStage, match.stage);
      winner.firstWinAt = Math.min(winner.firstWinAt, match.created);
      if (match.created >= winner.seenAt) {
        winner.model = match.winnerModel;
        winner.provider = match.winnerProvider;
        winner.seenAt = match.created;
      }
      const bucket = winner.byTournamentPoints.get(match.tournamentId) ?? {
        tournamentId: match.tournamentId,
        points: 0,
        wins: 0,
      };
      bucket.points += match.points;
      bucket.wins++;
      winner.byTournamentPoints.set(match.tournamentId, bucket);

      const loser = rowFor(match.loserId);
      loser.losses++;
      if (match.created >= loser.seenAt) {
        loser.model = match.loserModel;
        loser.provider = match.loserProvider;
        loser.seenAt = match.created;
      }
    }
  }

  const list = [...rows.values()];
  for (const row of list) row.byTournament = [...row.byTournamentPoints.values()];

  /*
   * Points descending, then head-to-head among the tied, then the earlier first win, then id.
   *
   * Head-to-head is computed inside a tie group: among contenders on equal points, whoever
   * won their own meetings ranks higher. It is the one comparison the bracket actually
   * settled, and it needs nothing stored — the matches are already in hand.
   */
  list.sort((a, b) => b.points - a.points || a.contenderId.localeCompare(b.contenderId));

  let start = 0;
  while (start < list.length) {
    let end = start + 1;
    while (end < list.length && list[end]!.points === list[start]!.points) end++;

    if (end - start > 1) {
      const group = new Set(list.slice(start, end).map((row) => row.contenderId));
      const headToHead = new Map<string, number>();
      for (const match of decisive) {
        if (!group.has(match.winnerId) || !group.has(match.loserId)) continue;
        headToHead.set(match.winnerId, (headToHead.get(match.winnerId) ?? 0) + 1);
      }

      const tied = list.slice(start, end);
      tied.sort(
        (a, b) =>
          (headToHead.get(b.contenderId) ?? 0) - (headToHead.get(a.contenderId) ?? 0) ||
          a.firstWinAt - b.firstWinAt ||
          a.contenderId.localeCompare(b.contenderId),
      );
      for (let i = 0; i < tied.length; i++) list[start + i] = tied[i]!;
    }

    start = end;
  }

  return list;
}
