/**
 * One tournament match, judged blind.
 *
 * The same bargain the benchmark makes: nothing that identifies a contender reaches the DOM
 * until the verdict is in — no name, no model, no provider, no timings, no colour — and the
 * sides are a coin flip at draw time. The bracket knows *who* is in the match, because a
 * bracket has to; what it must not reveal is which of the two replies belongs to whom.
 *
 * The dead-heat rule is the one place this differs from a benchmark round. A bracket must
 * produce a winner, so `tie` (both equally good) and `bad` (neither usable) do not record:
 * they re-roll both sides once against the same prompt, and if it is *still* a dead heat the
 * judge has to pick. That forced pick is the only verdict that is recorded, `rerolled: true`
 * noting the extra roll. If the re-roll produces no evidence on one side, the caller resets
 * the match to un-played instead of asking for a judgement nothing supports.
 */

import type { Verdict } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useEffect } from 'react';
import { StopIcon } from '../../../layout/icons.tsx';
import { characterApi } from '../../../lib/api.ts';
import { ContenderColumn } from '../ContenderColumn.tsx';
import type { ArenaDisplay } from '../display.ts';
import { viewSeries } from '../series.ts';
import { isRunSettled } from '../state/arenaReducer.ts';
import type { UseArenaRun } from '../useArenaRun.ts';

const VOTES: { verdict: Verdict; label: string; key: string; hint: string }[] = [
  { verdict: 'left', label: 'A is better', key: '1', hint: 'A advances' },
  {
    verdict: 'tie',
    label: 'Tie',
    key: '=',
    hint: 'Equally good — both replies are re-rolled once',
  },
  { verdict: 'right', label: 'B is better', key: '2', hint: 'B advances' },
  {
    verdict: 'bad',
    label: 'Neither is usable',
    key: '0',
    hint: 'Both failed — both replies are re-rolled once',
  },
];

interface TournamentMatchRoomProps {
  /** The card's summary, for the stage header. */
  character: CharacterSummary | null;
  characterId: string;
  cue: string;
  /** "Semi-finals · match 1 of 2", already composed by the caller. */
  stageLabel: string;
  run: UseArenaRun;
  pending: boolean;
  revealed: boolean;
  recording: boolean;
  error: string | null;
  /** The first roll was a dead heat, so the only verdicts left are A and B. */
  deadHeat: boolean;
  /** Withhold settled text too, so the first column to finish cannot give itself away. */
  holdUntilComplete: boolean;
  displayFor: (characterId: string) => ArenaDisplay;
  preferredSlots: ReadonlyMap<string, number>;
  onVote: (verdict: Verdict) => void;
  onBack: () => void;
}

export function TournamentMatchRoom({
  character,
  characterId,
  cue,
  stageLabel,
  run,
  pending,
  revealed,
  recording,
  error,
  deadHeat,
  holdUntilComplete,
  displayFor,
  preferredSlots,
  onVote,
  onBack,
}: TournamentMatchRoomProps) {
  const current = run.state.runs[0] ?? null;
  const settled = current ? isRunSettled(current) : false;
  const canVote = Boolean(current) && settled && !revealed && !recording && !pending;

  /*
   * Keyboard judging, on the window like the benchmark's — there is nothing on this screen
   * you would sensibly be tabbed into while reading two replies. Once the dead heat has been
   * re-rolled only the two advancement keys remain, because they are the only verdicts left.
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

      if (event.key === 'Escape' && run.busy) {
        event.preventDefault();
        run.abort();
        return;
      }
      if (!canVote) return;

      const allowed = deadHeat
        ? VOTES.filter((vote) => vote.verdict !== 'tie' && vote.verdict !== 'bad')
        : VOTES;
      const vote = allowed.find((entry) => entry.key === event.key);
      if (!vote) return;
      event.preventDefault();
      onVote(vote.verdict);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canVote, deadHeat, onVote, run]);

  const colours = current
    ? viewSeries(
        current.entries.map((entry) => entry.contenderId),
        preferredSlots,
      )
    : new Map<string, string>();

  const nameOf = (index: 0 | 1) =>
    current?.entries[index]?.name || current?.entries[index]?.contenderId || '—';

  const choices = deadHeat
    ? VOTES.filter((vote) => vote.verdict === 'left' || vote.verdict === 'right')
    : VOTES;

  return (
    <div className="arena-blind" data-revealed={revealed}>
      <header className="arena-blind__stage">
        <button type="button" className="wc-button wc-button--ghost" onClick={onBack}>
          Bracket
        </button>
        <img className="arena-blind__avatar" src={characterApi.imageUrl(characterId)} alt="" />
        <div className="arena-blind__scene">
          <span className="arena-blind__character">{character?.name ?? characterId}</span>
          <p className="arena-blind__probe">{cue}</p>
        </div>

        <div className="arena-blind__meta">
          <span className="arena-tour__stagelabel">{stageLabel}</span>
          {run.busy ? (
            <button
              type="button"
              className="wc-button wc-button--danger"
              onClick={() => run.abort()}
            >
              <StopIcon />
              Stop
            </button>
          ) : null}
        </div>
      </header>

      {run.error ? (
        <p className="arena-error" role="alert">
          {run.error}
        </p>
      ) : null}
      {error ? (
        <p className="arena-error" role="alert">
          {error}
        </p>
      ) : null}

      {current ? (
        <>
          <div className="arena-duel">
            {current.entries.map((entry, index) => (
              <ContenderColumn
                key={entry.contenderId}
                entry={entry}
                stream={run.streams[index] ?? null}
                display={displayFor(characterId)}
                masked={!revealed}
                maskLabel={index === 0 ? 'A' : 'B'}
                // Holding is a rendering decision; the request still streams so Stop keeps
                // whatever had arrived. A settled round releases the hold, exactly as the
                // benchmark does — otherwise the first column to finish would give itself up.
                hold={holdUntilComplete && !settled}
                colour={colours.get(entry.contenderId)}
              />
            ))}
          </div>

          <div className="arena-vote" data-revealed={revealed} data-forced={deadHeat}>
            {revealed ? (
              <div className="arena-vote__result" role="status" aria-live="polite">
                <span className="arena-vote__outcome">
                  <strong>A</strong> was {nameOf(0)} · <strong>B</strong> was {nameOf(1)}
                </span>
                {recording ? <span className="arena-vote__saving">Recording…</span> : null}
                <button
                  type="button"
                  className="wc-button wc-button--primary"
                  onClick={onBack}
                  disabled={recording}
                >
                  Back to bracket
                </button>
              </div>
            ) : (
              <>
                {deadHeat ? (
                  <p className="arena-tour__forced">
                    Dead heat — both replies were re-rolled. Pick who advances.
                  </p>
                ) : null}
                {choices.map((vote) => (
                  <button
                    key={vote.verdict}
                    type="button"
                    className={
                      vote.verdict === 'bad'
                        ? 'arena-vote__minor'
                        : vote.verdict === 'tie' || deadHeat
                          ? 'wc-button arena-vote__button'
                          : 'wc-button wc-button--primary arena-vote__button'
                    }
                    data-vote={vote.verdict}
                    onClick={() => onVote(vote.verdict)}
                    disabled={!settled || recording || pending}
                    title={settled ? vote.hint : 'Both replies are still being written'}
                  >
                    <kbd className="arena-key">{vote.key}</kbd>
                    {deadHeat
                      ? vote.verdict === 'left'
                        ? 'A advances'
                        : 'B advances'
                      : vote.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      ) : (
        <p className="wc-empty">Preparing the match…</p>
      )}
    </div>
  );
}
