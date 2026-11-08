/**
 * The Arena's numbers beyond the rating itself: sittings, form, the best model for each
 * character, reply length against wins, how you vote, upsets, and what rounds cost.
 *
 * Every one is read off the recorded rounds — the merged view the leaderboard reads — so
 * nothing here is stored and nothing can drift from the history behind it. Ratings come from
 * `replay`, never a second Elo loop.
 */

import type { ArenaRound, Contender, RoundSide, RoundUsage } from '@shared/types/arena.ts';
import { replay } from '../features/arena/elo.ts';

/** A pause longer than this between two rounds ends a sitting. */
export const SITTING_GAP_MS = 45 * 60_000;
/** The leaderboard's band shows the latest sitting while it is this recent. */
export const SITTING_FRESH_MS = 18 * 60 * 60_000;

export interface Sitting {
  /** Index into the chronological rounds of the sitting's first round. */
  from: number;
  /** One past its last round. */
  to: number;
  start: number;
  end: number;
}

function chronological(rounds: readonly ArenaRound[]): ArenaRound[] {
  return [...rounds].sort((a, b) => a.created - b.created);
}

/** The history cut into sittings: runs of rounds with no long pause inside them. */
export function sittings(rounds: readonly ArenaRound[], gap = SITTING_GAP_MS): Sitting[] {
  const ordered = chronological(rounds);
  const out: Sitting[] = [];
  ordered.forEach((round, index) => {
    const last = out[out.length - 1];
    if (last && round.created - last.end <= gap) {
      last.to = index + 1;
      last.end = round.created;
    } else {
      out.push({ from: index, to: index + 1, start: round.created, end: round.created });
    }
  });
  return out;
}

export interface SittingSummary {
  sitting: Sitting;
  rounds: ArenaRound[];
  /** Rating change over the sitting, by contender. Only those who played. */
  moves: Map<string, number>;
  /** Won and lost inside the sitting, by contender. */
  records: Map<string, { wins: number; losses: number; ties: number }>;
  /** The round where the lowest-rated winner beat the highest-rated loser, if any. */
  upset: Upset | null;
}

/**
 * The latest sitting, if it ended recently enough to still be "this sitting".
 *
 * Ratings either side come from replaying the history up to the sitting's start and up to
 * its end, so the moves add up to what the board shows.
 */
export function latestSitting(
  rounds: readonly ArenaRound[],
  contenders: readonly Contender[],
  now: number,
  fresh = SITTING_FRESH_MS,
): SittingSummary | null {
  const all = sittings(rounds);
  const sitting = all[all.length - 1];
  if (!sitting || now - sitting.end > fresh) return null;
  const ordered = chronological(rounds);
  const before = new Map(
    replay(ordered.slice(0, sitting.from), contenders).rows.map((row) => [
      row.contenderId,
      row.rating,
    ]),
  );
  const after = replay(ordered.slice(0, sitting.to), contenders).rows;
  const inside = ordered.slice(sitting.from, sitting.to);

  const played = new Set(
    inside.flatMap((round) => [round.left.contenderId, round.right.contenderId]),
  );
  const moves = new Map<string, number>();
  for (const row of after) {
    if (!played.has(row.contenderId)) continue;
    moves.set(row.contenderId, row.rating - (before.get(row.contenderId) ?? 1500));
  }

  const records = new Map<string, { wins: number; losses: number; ties: number }>();
  const record = (id: string) => {
    let entry = records.get(id);
    if (!entry) {
      entry = { wins: 0, losses: 0, ties: 0 };
      records.set(id, entry);
    }
    return entry;
  };
  for (const round of inside) {
    const left = record(round.left.contenderId);
    const right = record(round.right.contenderId);
    if (round.verdict === 'left') {
      left.wins++;
      right.losses++;
    } else if (round.verdict === 'right') {
      right.wins++;
      left.losses++;
    } else if (round.verdict === 'tie') {
      left.ties++;
      right.ties++;
    }
  }

  const upset = upsets(ordered, contenders, 1, sitting.from)[0] ?? null;
  return { sitting, rounds: inside, moves, records, upset };
}

export type FormMark = 'w' | 'l' | 't' | 'b';

/** A contender's last `count` results, oldest first. `b` is a round you threw both out of. */
export function form(rounds: readonly ArenaRound[], contenderId: string, count = 10): FormMark[] {
  const marks: FormMark[] = [];
  const ordered = chronological(rounds);
  for (let index = ordered.length - 1; index >= 0 && marks.length < count; index--) {
    const round = ordered[index]!;
    const side =
      round.left.contenderId === contenderId
        ? 'left'
        : round.right.contenderId === contenderId
          ? 'right'
          : null;
    if (!side) continue;
    marks.push(
      round.verdict === 'bad'
        ? 'b'
        : round.verdict === 'tie'
          ? 't'
          : round.verdict === side
            ? 'w'
            : 'l',
    );
  }
  return marks.reverse();
}

export interface CardBest {
  characterId: string;
  /** Best first. Only contenders with at least `minRounds` decided rounds on the card. */
  leaders: { contenderId: string; wins: number; losses: number; ties: number; share: number }[];
  rounds: number;
}

/**
 * Who wins most on each character. A share of points (a tie is half), so a model that
 * played three rounds there cannot top one that played thirty by luck alone: `minRounds`.
 */
export function bestPerCard(rounds: readonly ArenaRound[], minRounds = 3): CardBest[] {
  const byCard = new Map<string, Map<string, { wins: number; losses: number; ties: number }>>();
  const counts = new Map<string, number>();
  for (const round of rounds) {
    counts.set(round.characterId, (counts.get(round.characterId) ?? 0) + 1);
    if (round.verdict === 'bad') continue;
    let table = byCard.get(round.characterId);
    if (!table) {
      table = new Map();
      byCard.set(round.characterId, table);
    }
    const get = (id: string) => {
      let entry = table!.get(id);
      if (!entry) {
        entry = { wins: 0, losses: 0, ties: 0 };
        table!.set(id, entry);
      }
      return entry;
    };
    const left = get(round.left.contenderId);
    const right = get(round.right.contenderId);
    if (round.verdict === 'tie') {
      left.ties++;
      right.ties++;
    } else if (round.verdict === 'left') {
      left.wins++;
      right.losses++;
    } else {
      right.wins++;
      left.losses++;
    }
  }
  return [...byCard]
    .map(([characterId, table]) => ({
      characterId,
      rounds: counts.get(characterId) ?? 0,
      leaders: [...table]
        .map(([contenderId, r]) => ({
          contenderId,
          ...r,
          share: (r.wins + r.ties / 2) / Math.max(1, r.wins + r.losses + r.ties),
        }))
        .filter((r) => r.wins + r.losses + r.ties >= minRounds)
        .sort((a, b) => b.share - a.share || b.wins - a.wins),
    }))
    .filter((card) => card.leaders.length > 0)
    .sort((a, b) => b.rounds - a.rounds);
}

export function wordCount(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

export interface LengthPoint {
  contenderId: string;
  words: number;
  /** Share of points in rated rounds, 0–1. */
  share: number;
  rounds: number;
}

/** Each contender's average reply length against how often it wins. */
export function lengthVsWins(rounds: readonly ArenaRound[], minRounds = 5): LengthPoint[] {
  const tally = new Map<
    string,
    { words: number; replies: number; points: number; rated: number }
  >();
  const add = (side: RoundSide, points: number | null) => {
    let entry = tally.get(side.contenderId);
    if (!entry) {
      entry = { words: 0, replies: 0, points: 0, rated: 0 };
      tally.set(side.contenderId, entry);
    }
    entry.words += wordCount(side.text);
    entry.replies++;
    if (points !== null) {
      entry.points += points;
      entry.rated++;
    }
  };
  for (const round of rounds) {
    const score = (side: 'left' | 'right') =>
      round.verdict === 'bad'
        ? null
        : round.verdict === 'tie'
          ? 0.5
          : round.verdict === side
            ? 1
            : 0;
    add(round.left, score('left'));
    add(round.right, score('right'));
  }
  return [...tally]
    .filter(([, entry]) => entry.rated >= minRounds)
    .map(([contenderId, entry]) => ({
      contenderId,
      words: Math.round(entry.words / entry.replies),
      share: entry.points / entry.rated,
      rounds: entry.rated,
    }));
}

export interface VoteMix {
  left: number;
  right: number;
  tie: number;
  bad: number;
  total: number;
  /** Share of each contender's rounds you threw both replies out of. */
  bothBad: { contenderId: string; share: number; rounds: number }[];
}

export function voteMix(rounds: readonly ArenaRound[], minRounds = 5): VoteMix {
  const mix = { left: 0, right: 0, tie: 0, bad: 0 };
  const per = new Map<string, { bad: number; rounds: number }>();
  for (const round of rounds) {
    mix[round.verdict]++;
    for (const side of [round.left, round.right]) {
      const entry = per.get(side.contenderId) ?? { bad: 0, rounds: 0 };
      entry.rounds++;
      if (round.verdict === 'bad') entry.bad++;
      per.set(side.contenderId, entry);
    }
  }
  return {
    ...mix,
    total: rounds.length,
    bothBad: [...per]
      .filter(([, entry]) => entry.rounds >= minRounds)
      .map(([contenderId, entry]) => ({
        contenderId,
        share: entry.bad / entry.rounds,
        rounds: entry.rounds,
      }))
      .sort((a, b) => b.share - a.share),
  };
}

export interface Upset {
  round: ArenaRound;
  /** Its position in the chronological history, counting from 1. */
  number: number;
  winnerId: string;
  loserId: string;
  /** How far below the loser the winner was rated going in. Always positive. */
  gap: number;
}

/**
 * Rounds a lower-rated contender won, biggest gap first, rated as they stood going in.
 * `from` skips rounds before that chronological index (a sitting's own upsets).
 */
export function upsets(
  rounds: readonly ArenaRound[],
  contenders: readonly Contender[],
  count = 3,
  from = 0,
): Upset[] {
  const { series, ordered } = replay(rounds, contenders);
  const lines = new Map(series.map((line) => [line.contenderId, line.points]));
  const before = (id: string, index: number) => lines.get(id)?.[index]?.rating ?? 1500;
  const found: Upset[] = [];
  ordered.forEach((round, index) => {
    if (index < from || (round.verdict !== 'left' && round.verdict !== 'right')) return;
    const winner = round.verdict === 'left' ? round.left : round.right;
    const loser = round.verdict === 'left' ? round.right : round.left;
    const gap = before(loser.contenderId, index) - before(winner.contenderId, index);
    if (gap <= 0) return;
    found.push({
      round,
      number: index + 1,
      winnerId: winner.contenderId,
      loserId: loser.contenderId,
      gap,
    });
  });
  return found.sort((a, b) => b.gap - a.gap).slice(0, count);
}

// ---------- Cost ----------

/** Per-token prices from the catalogue, for one connection and model. */
export interface Price {
  prompt: number;
  completion: number;
}

export type PriceOf = (connectionId: string, model: string) => Price | null;

/** One reply's cost, or null when it recorded no usage or its model has no price. */
export function sideCost(side: RoundSide, priceOf: PriceOf): number | null {
  const usage: RoundUsage | undefined = side.usage;
  if (!usage) return null;
  const price = priceOf(usage.connectionId, side.model);
  if (!price || (usage.promptTokens === null && usage.completionTokens === null)) return null;
  return (
    (usage.promptTokens ?? 0) * price.prompt + (usage.completionTokens ?? 0) * price.completion
  );
}

export interface Spend {
  usd: number;
  tokens: number;
  /** Every reply had usage and a price. */
  complete: boolean;
  /** At least one reply could be priced. */
  priced: boolean;
}

/** What a set of rounds cost, from the usage they recorded at catalogue prices. */
export function roundsCost(rounds: readonly ArenaRound[], priceOf: PriceOf): Spend {
  let usd = 0;
  let tokens = 0;
  let priced = 0;
  let sides = 0;
  for (const round of rounds) {
    for (const side of [round.left, round.right]) {
      sides++;
      const usage = side.usage;
      if (usage) tokens += (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
      const cost = sideCost(side, priceOf);
      if (cost === null) continue;
      usd += cost;
      priced++;
    }
  }
  return { usd, tokens, complete: sides > 0 && priced === sides, priced: priced > 0 };
}

/** The connection and model pairs a set of rounds needs prices for. */
export function pricedModels(
  rounds: readonly ArenaRound[],
): { connectionId: string; model: string }[] {
  const seen = new Map<string, { connectionId: string; model: string }>();
  for (const round of rounds) {
    for (const side of [round.left, round.right]) {
      if (!side.usage) continue;
      seen.set(`${side.usage.connectionId}\u0000${side.model}`, {
        connectionId: side.usage.connectionId,
        model: side.model,
      });
    }
  }
  return [...seen.values()];
}

export function formatSeconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** "38 min", "1 h 12 min". */
export function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function kTokensShort(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
