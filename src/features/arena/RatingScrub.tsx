/**
 * The round axis made legible: one tick per round, coloured by what you decided.
 *
 * Lifted out of `RatingChart` when the forest plot arrived, because the strip belongs to
 * neither graph. It is the only place the shape of a sitting is visible — a run of
 * one-sided verdicts, a patch of ties, the round where you rejected both — and the only
 * door into `RoundInspector`, since every round stores the full text of both replies.
 * Whichever figure the board is showing, the strip beneath it is the same.
 *
 * Buttons rather than decoration, because each one opens something — and a keyboard user
 * gets the same access to the history as a pointer does.
 */

import type { ArenaRound } from '@shared/types/arena.ts';

interface RatingScrubProps {
  /** The rounds behind the axis, oldest first — the same order the series were built in. */
  ordered: readonly ArenaRound[];
  /** The round the parent is currently reading, one-based. Null in views with no crosshair. */
  current?: number | null;
  /** Pointer or keyboard focus landed on a tick, one-based round number. */
  onHighlight?: (roundNumber: number) => void;
  /** Open the round a tick stands for. */
  onOpenRound: (round: ArenaRound) => void;
}

function verdictWord(verdict: ArenaRound['verdict']): string {
  if (verdict === 'left') return 'A won';
  if (verdict === 'right') return 'B won';
  if (verdict === 'tie') return 'a tie';
  return 'both rejected';
}

export function RatingScrub({
  ordered,
  current = null,
  onHighlight,
  onOpenRound,
}: RatingScrubProps) {
  return (
    <ol className="rating-scrub" aria-label="Every recorded round, by verdict">
      {ordered.map((round, index) => (
        <li key={round.id} className="rating-scrub__slot">
          <button
            type="button"
            className="rating-scrub__tick"
            data-verdict={round.verdict}
            data-current={current === index + 1}
            onMouseEnter={() => onHighlight?.(index + 1)}
            onFocus={() => onHighlight?.(index + 1)}
            onClick={() => onOpenRound(round)}
            title={`Round ${index + 1} — ${verdictWord(round.verdict)}. Open it.`}
          >
            <span className="wc-visually-hidden">
              Round {index + 1}, {verdictWord(round.verdict)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
