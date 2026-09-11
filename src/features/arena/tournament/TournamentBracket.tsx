/**
 * The bracket, drawn as one column per stage.
 *
 * A column is a flex column with its matches spread evenly down it, which is what makes a
 * stage with one match sit opposite the middle of the two that fed it — the tree shape falls
 * out of the layout without a single measured connector. Names are shown: a bracket has to
 * say who is in it, and the blind covers the *replies*, not the matchup. Which side a
 * contender takes in a match is still a coin flip at draw time.
 *
 * A slot is playable when both its sides are known — which, because a side only resolves
 * from a recorded feeder, is exactly when the match before it is a real comparison.
 */

import type { TournamentWithMatches } from '@shared/types/arena.ts';
import type { BracketView } from './bracket.ts';
import { stageName } from './bracket.ts';

interface TournamentBracketProps {
  tournament: TournamentWithMatches;
  view: BracketView;
  nameFor: (contenderId: string) => string;
  /** The slot currently being played, so its card can say so rather than offering Play again. */
  active: { stage: number; matchIndex: number } | null;
  /** Why a match cannot be started right now, if it cannot. */
  disabledReason: string | null;
  onPlay: (stage: number, matchIndex: number) => void;
}

export function TournamentBracket({
  tournament,
  view,
  nameFor,
  active,
  disabledReason,
  onPlay,
}: TournamentBracketProps) {
  return (
    <div className="arena-tour__bracket">
      {view.stages.map((row, stage) => (
        // A stage's index is its identity: the array is positional, and stage 0 is the first
        // round by definition. There is no other key to use.
        // biome-ignore lint/suspicious/noArrayIndexKey: stage order is the identity
        <section className="arena-tour__stage" key={stage}>
          <h3 className="arena-tour__stagehead">{stageName(tournament.size, stage)}</h3>

          <div className="arena-tour__slots">
            {row.map((slot) => {
              const decided = slot.match !== null;
              const playable = !decided && slot.leftId !== null && slot.rightId !== null;
              const playing =
                active?.stage === slot.stage && active?.matchIndex === slot.matchIndex;

              return (
                <article
                  className="arena-tour__match"
                  key={slot.matchIndex}
                  data-decided={decided}
                  data-playable={playable}
                  data-playing={playing}
                >
                  {[
                    { id: slot.leftId, side: 'left' as const },
                    { id: slot.rightId, side: 'right' as const },
                  ].map((entry) => {
                    const won = decided && slot.match?.verdict === entry.side;
                    return (
                      <div
                        className="arena-tour__side"
                        key={entry.side}
                        data-won={won}
                        data-empty={entry.id === null}
                      >
                        <span className="arena-tour__name">
                          {entry.id ? nameFor(entry.id) : 'Awaiting winner'}
                        </span>
                        {won ? <span className="arena-tour__won">won</span> : null}
                      </div>
                    );
                  })}

                  {playing ? (
                    <span className="arena-tour__state">Playing…</span>
                  ) : playable ? (
                    <button
                      type="button"
                      className="wc-button wc-button--primary arena-tour__play"
                      disabled={disabledReason !== null}
                      title={disabledReason ?? 'Fight this match'}
                      onClick={() => onPlay(slot.stage, slot.matchIndex)}
                    >
                      Fight
                    </button>
                  ) : decided ? null : (
                    <span className="arena-tour__state">Awaiting winner</span>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
