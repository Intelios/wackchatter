/**
 * The blind round: the part that produces a number worth trusting.
 *
 * Everything that could identify a contender is withheld until the vote is in — the name,
 * the model, the provider, the timings, its corner colour, the reasoning text (models name
 * themselves in it), and by default the streaming itself, because cadence gives a model away
 * as surely as a label does. What is left is two pieces of prose and a question.
 *
 * The card and the cue stay visible throughout. They are what the two are being judged on,
 * and hiding them would only make the judgement vaguer.
 *
 * Three things about the shape of this screen are deliberate. It does not scroll: a round is
 * a room you are in until you vote, and a vote bar that can leave the viewport turns a
 * forty-round sitting into forty small hunts. The two verdict buttons sit **under their own
 * panes**, because "A is better" in a centred row is a sentence about a thing that is
 * somewhere else. And the whole loop is playable from the keyboard, which is the difference
 * between a benchmark someone finishes and one they abandon at round six.
 */

import type { ArenaSettings, Verdict } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useEffect } from 'react';
import { RefreshIcon, StopIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { ContenderColumn } from './ContenderColumn.tsx';
import type { ArenaDisplay } from './display.ts';
import type { VerdictPreview } from './elo.ts';
import type { RoundDraw } from './pairing.ts';
import { viewSeries } from './series.ts';
import { isRunSettled } from './state/arenaReducer.ts';
import type { UseArenaRun } from './useArenaRun.ts';

interface BlindRoundProps {
  settings: ArenaSettings;
  characters: readonly CharacterSummary[];
  run: UseArenaRun;
  /** The identities behind this round. Never rendered until `revealed`. */
  draw: RoundDraw | null;
  revealed: boolean;
  recording: boolean;
  recordError: string | null;
  displayFor: (characterId: string) => ArenaDisplay;
  onNext: () => void;
  onVote: (verdict: Verdict) => void;
  /** Why a round cannot be drawn. Null when one can. */
  blockedReason: string | null;
  /** Every verdict given this sitting, oldest first. */
  sessionVerdicts: readonly Verdict[];
  /** What the vote just did to the two ratings. Null until revealed. */
  preview: VerdictPreview | null;
  preferredSlots: ReadonlyMap<string, number>;
}

const VOTES: { verdict: Verdict; label: string; key: string; hint: string }[] = [
  {
    verdict: 'left',
    label: 'A is better',
    key: '1',
    hint: 'A wrote the reply you would keep',
  },
  {
    verdict: 'tie',
    label: 'Tie',
    key: '=',
    hint: 'Both are good, and equally so',
  },
  {
    verdict: 'right',
    label: 'B is better',
    key: '2',
    hint: 'B wrote the reply you would keep',
  },
  {
    verdict: 'bad',
    label: 'Neither is usable',
    key: '0',
    hint: 'Recorded, but it moves no ratings — it says nothing about which is better.',
  },
];

const STREAK_MARK: Record<Verdict, string> = {
  left: 'A',
  right: 'B',
  tie: 'T',
  bad: '×',
};

/** The last of the sitting's verdicts that will fit on the bar without becoming a chart. */
const STREAK_LENGTH = 20;

export function BlindRound({
  settings,
  characters,
  run,
  draw,
  revealed,
  recording,
  recordError,
  displayFor,
  onNext,
  onVote,
  blockedReason,
  sessionVerdicts,
  preview,
  preferredSlots,
}: BlindRoundProps) {
  const current = run.state.runs[0] ?? null;
  const settled = current ? isRunSettled(current) : false;
  const hold = settings.holdBlindUntilComplete && !settled;
  const character = current
    ? characters.find((entry) => entry.avatar === current.characterId)
    : null;

  const canVote = Boolean(current) && settled && !revealed && !recording;
  const canAdvance = !run.busy && !blockedReason && (!current || revealed);

  /*
   * Keyboard voting.
   *
   * Bound to the window rather than to a focused element: there is nothing on this screen
   * you would sensibly be tabbed into while reading two replies, and requiring a focus ring
   * somewhere before the keys work would defeat the point. Guarded against text entry all
   * the same, because the Pool's fields are one tab away and a benchmark that eats the "1"
   * you were typing into a cue is worse than no shortcut at all.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }

      if (event.key === ' ' || event.key === 'Spacebar') {
        if (!canAdvance) return;
        event.preventDefault();
        onNext();
        return;
      }

      if (event.key === 'Escape' && run.busy) {
        event.preventDefault();
        run.abort();
        return;
      }

      if (!canVote) return;
      const vote = VOTES.find((entry) => entry.key === event.key);
      if (!vote) return;
      event.preventDefault();
      onVote(vote.verdict);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canAdvance, canVote, onNext, onVote, run]);

  /*
   * Colours for the reveal only.
   *
   * Resolved from the draw rather than from the run's entries so that the two sides cannot
   * wear the same colour, and never applied while masked — see ContenderColumn.
   */
  const colours = draw ? viewSeries([draw.left.id, draw.right.id], preferredSlots) : new Map();

  const revealFor = (side: 0 | 1) => {
    if (!revealed || !draw || !preview) return null;
    const contender = side === 0 ? draw.left : draw.right;
    const move = side === 0 ? preview.left : preview.right;
    return {
      name: contender.name.trim() || contender.model.trim() || contender.id,
      rating: move.after,
      delta: move.delta,
    };
  };

  const streak = sessionVerdicts.slice(-STREAK_LENGTH);

  return (
    <div className="arena-blind" data-revealed={revealed}>
      {/* ------------------------------------------------------------- stage */}
      <header className="arena-blind__stage">
        {current ? (
          <>
            <img
              className="arena-blind__avatar"
              src={characterApi.imageUrl(current.characterId)}
              alt=""
            />
            <div className="arena-blind__scene">
              <span className="arena-blind__character">
                {character?.name ?? current.characterId}
              </span>
              <p className="arena-blind__probe">{current.probe}</p>
            </div>
          </>
        ) : (
          <div className="arena-blind__intro">
            <p>
              Each round draws a card, a cue and two contenders from your pools. You read both
              replies and pick one; only then do you find out who wrote them.
            </p>
          </div>
        )}

        <div className="arena-blind__meta">
          {streak.length > 0 ? (
            <div className="arena-blind__session">
              <span className="arena-blind__count">
                {sessionVerdicts.length} judged · {sessionVerdicts.length * 2} generations
              </span>
              <ol
                className="arena-streak"
                aria-label={`This sitting: ${streak.map((verdict) => STREAK_MARK[verdict]).join(', ')}`}
              >
                {streak.map((verdict, index) => (
                  <li
                    // Verdicts are not unique and carry no id; position in the sitting is
                    // exactly what each tick means.
                    // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity
                    key={index}
                    className="arena-streak__tick"
                    data-verdict={verdict}
                  />
                ))}
              </ol>
            </div>
          ) : null}

          {/*
           * The fairness claim, said out loud.
           *
           * Pairing coin-flips the sides every round so position bias cannot bind to one
           * contender for the whole history. The code has always done it; the screen has
           * never mentioned it, which leaves the user to wonder whether A is "the first one".
           */}
          <p className="arena-blind__fair">Sides are a coin flip each round.</p>

          {run.busy ? (
            <button
              type="button"
              className="wc-button wc-button--danger"
              onClick={() => run.abort()}
            >
              <StopIcon />
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="wc-button wc-button--primary"
              onClick={onNext}
              disabled={!canAdvance}
              title={
                blockedReason ??
                (current && !revealed ? 'Judge this round first' : 'Draw the next round')
              }
            >
              <RefreshIcon />
              {current ? 'Next round' : 'Start benchmarking'}
            </button>
          )}
        </div>
      </header>

      {blockedReason && !current ? <p className="wc-empty">{blockedReason}</p> : null}
      {run.error ? (
        <p className="arena-error" role="alert">
          {run.error}
        </p>
      ) : null}
      {recordError ? (
        <p className="arena-error" role="alert">
          {recordError}
        </p>
      ) : null}

      {current ? (
        <>
          {/* ------------------------------------------------------------ duel */}
          <div className="arena-duel">
            {current.entries.map((entry, index) => {
              const side = index === 0 ? 0 : 1;
              const contender = draw ? (side === 0 ? draw.left : draw.right) : null;
              return (
                <ContenderColumn
                  key={entry.contenderId}
                  entry={entry}
                  stream={run.streams[index] ?? null}
                  display={displayFor(current.characterId)}
                  masked={!revealed}
                  maskLabel={index === 0 ? 'A' : 'B'}
                  hold={hold}
                  colour={contender ? colours.get(contender.id) : undefined}
                  reveal={revealFor(side as 0 | 1)}
                />
              );
            })}
          </div>

          {/* ------------------------------------------------------------ vote */}
          <div className="arena-vote" data-revealed={revealed}>
            {revealed ? (
              <div className="arena-vote__result" role="status" aria-live="polite">
                {/* The draw, not the run entries: the entries carry the labels, but reading
                    the reveal off the draw is what proves the two never disagreed. */}
                <span className="arena-vote__outcome">
                  {draw ? (
                    <>
                      <strong>A</strong> was {labelOf(draw, 0)} · <strong>B</strong> was{' '}
                      {labelOf(draw, 1)}
                    </>
                  ) : (
                    '—'
                  )}
                </span>
                {recording ? <span className="arena-vote__saving">Recording…</span> : null}
                <button
                  type="button"
                  className="wc-button wc-button--primary"
                  onClick={onNext}
                  disabled={!canAdvance}
                >
                  <RefreshIcon />
                  Next round
                  <kbd className="arena-key">space</kbd>
                </button>
              </div>
            ) : (
              VOTES.map((vote) => (
                <button
                  key={vote.verdict}
                  type="button"
                  className={
                    vote.verdict === 'bad'
                      ? 'arena-vote__minor'
                      : vote.verdict === 'tie'
                        ? 'wc-button arena-vote__button'
                        : 'wc-button wc-button--primary arena-vote__button'
                  }
                  // Placed by the verdict it casts: the CSS grid puts `left` under the left
                  // pane and `right` under the right, so a vote is never a sentence about
                  // something on the other side of the screen.
                  data-vote={vote.verdict}
                  onClick={() => onVote(vote.verdict)}
                  disabled={!settled || recording}
                  title={settled ? vote.hint : 'Both replies are still being written'}
                >
                  {vote.verdict === 'right' ? null : <kbd className="arena-key">{vote.key}</kbd>}
                  {vote.label}
                  {vote.verdict === 'right' ? <kbd className="arena-key">{vote.key}</kbd> : null}
                </button>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function labelOf(draw: RoundDraw, side: 0 | 1): string {
  const contender = side === 0 ? draw.left : draw.right;
  return contender.name.trim() || contender.model.trim() || contender.id;
}
