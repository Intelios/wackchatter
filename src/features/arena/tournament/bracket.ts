/**
 * The bracket as a replay of the matches.
 *
 * Nothing about who advanced is stored. `arena_tournaments` holds the plan — the entrants in
 * slot order and a card and cue per stage — and everything else here is derived by walking
 * the recorded matches forward through the tree. That is the same bargain the leaderboard
 * makes with `arena_rounds`: a bracket position cannot drift from the match that earned it
 * because there is no position to drift, only a replay.
 *
 * A slot's sides resolve only from a *recorded* feeder match, so a stage-0 slot is playable
 * the moment the tournament exists and every later slot waits for its two feeders. That also
 * means `next` needs no extra ordering rule: the first unplayed slot that has both sides is
 * necessarily the earliest one that can be played.
 */

import type {
  TournamentMatch,
  TournamentSize,
  TournamentWithMatches,
} from '@shared/types/arena.ts';
import { tournamentStageMatches, tournamentStages } from '@shared/types/arena.ts';
// The World Info generator, reused rather than duplicated — the same call `pairing.ts` makes.
import { createRng } from '@shared/worldinfo/rng.ts';

export interface BracketSlot {
  stage: number;
  matchIndex: number;
  /** Contender id, or null while the feeder match that fills this side is unplayed. */
  leftId: string | null;
  rightId: string | null;
  match: TournamentMatch | null;
  /** The winner's contender id once this slot is decided, else null. */
  winnerId: string | null;
}

export interface BracketView {
  size: TournamentSize;
  /** `stages[stageIndex][matchIndex]`. */
  stages: BracketSlot[][];
  /** The final's winner, or null while the bracket is unfinished. */
  championId: string | null;
  complete: boolean;
  /** The first playable unplayed slot, in stage then slot order. Null when none remain. */
  next: BracketSlot | null;
  playedMatches: number;
  totalMatches: number;
}

/** Which contender a recorded match advanced. Only left/right are ever stored. */
export function winnerIdOf(match: TournamentMatch): string {
  return match.verdict === 'left' ? match.left.contenderId : match.right.contenderId;
}

/** The contender a recorded match eliminated. */
export function loserIdOf(match: TournamentMatch): string {
  return match.verdict === 'left' ? match.right.contenderId : match.left.contenderId;
}

/**
 * Shuffle the entrants into bracket-slot order.
 *
 * Fisher-Yates over the shared seeded RNG, so a draw is reproducible from its seed and tests
 * can assert a fixed bracket. Production seeds with a uuid, which is what makes the seeding
 * random per tournament — the user picks who is in it, the draw decides where they land.
 */
export function seedEntrants(entrants: readonly string[], seed: string): string[] {
  const list = [...entrants];
  if (list.length < 2) return list;

  const rng = createRng(seed);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const a = list[i]!;
    const b = list[j]!;
    list[i] = b;
    list[j] = a;
  }
  return list;
}

/** What to call a stage in the UI. */
export function stageName(size: TournamentSize, stage: number): string {
  const entrants = size / 2 ** stage;
  switch (entrants) {
    case 2:
      return 'Final';
    case 4:
      return 'Semi-finals';
    case 8:
      return 'Quarter-finals';
    case 16:
      return 'Round of 16';
    default:
      return `Round of ${entrants}`;
  }
}

function slotKey(stage: number, matchIndex: number): string {
  return `${stage}:${matchIndex}`;
}

export function bracketView(tournament: TournamentWithMatches): BracketView {
  const { size, entrants } = tournament;
  const stageCount = tournamentStages(size);

  const recorded = new Map<string, TournamentMatch>();
  for (const match of tournament.matches) {
    recorded.set(slotKey(match.stage, match.matchIndex), match);
  }

  const stages: BracketSlot[][] = [];
  let playedMatches = 0;

  for (let stage = 0; stage < stageCount; stage++) {
    const count = tournamentStageMatches(size, stage);
    const row: BracketSlot[] = [];

    for (let matchIndex = 0; matchIndex < count; matchIndex++) {
      const match = recorded.get(slotKey(stage, matchIndex)) ?? null;
      if (match) playedMatches++;

      let leftId: string | null;
      let rightId: string | null;
      if (stage === 0) {
        leftId = entrants[matchIndex * 2] ?? null;
        rightId = entrants[matchIndex * 2 + 1] ?? null;
      } else {
        const feeders = stages[stage - 1]!;
        leftId = feeders[matchIndex * 2]?.winnerId ?? null;
        rightId = feeders[matchIndex * 2 + 1]?.winnerId ?? null;
      }

      row.push({
        stage,
        matchIndex,
        leftId,
        rightId,
        match,
        winnerId: match ? winnerIdOf(match) : null,
      });
    }

    stages.push(row);
  }

  const final = stages[stageCount - 1]?.[0] ?? null;
  const championId = final?.winnerId ?? null;

  let next: BracketSlot | null = null;
  for (const row of stages) {
    for (const slot of row) {
      // Both sides present means both feeders are recorded, so this is genuinely playable.
      if (!slot.match && slot.leftId !== null && slot.rightId !== null) {
        next = slot;
        break;
      }
    }
    if (next) break;
  }

  return {
    size,
    stages,
    championId,
    complete: championId !== null,
    next,
    playedMatches,
    totalMatches: size - 1,
  };
}
