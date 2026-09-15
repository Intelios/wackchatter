/**
 * The match currently in the room.
 *
 * Held by the Arena shell rather than the bracket screen so switching tabs mid-match does not
 * forget which slot is being fought — the run itself lives in the shell's engine, and this is
 * the other half of that state. `sides` is column 0 then column 1, already coin-flipped, and
 * it is the authority the verdict is recorded against: the run's entries carry labels, but the
 * draw is what proves the two never disagreed.
 */

export interface MatchRun {
  tournamentId: string;
  stage: number;
  matchIndex: number;
  sides: [string, string];
  /** The first roll was a dead heat, so only A/B are left and the verdict is `rerolled`. */
  deadHeat: boolean;
}
