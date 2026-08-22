/**
 * The blind round: the part that produces a number worth trusting.
 *
 * Everything that could identify a contender is withheld until the vote is in — the name,
 * the model, the provider, the timings, the reasoning text (models name themselves in it),
 * and by default the streaming itself, because cadence gives a model away as surely as a
 * label does. What is left is two pieces of prose and a question.
 *
 * The card and the probe stay visible throughout. They are what the two are being judged
 * on, and hiding them would only make the judgement vaguer.
 */

import type { ArenaSettings, Verdict } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { RefreshIcon, StopIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { ContenderColumn } from './ContenderColumn.tsx';
import type { ArenaDisplay } from './display.ts';
import type { RoundDraw } from './pairing.ts';
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
  /** Rounds judged in this sitting, and generations paid for. */
  sessionRounds: number;
}

const VOTES: { verdict: Verdict; label: string; hint: string }[] = [
  { verdict: 'left', label: 'A is better', hint: 'A wrote the reply you would keep' },
  { verdict: 'right', label: 'B is better', hint: 'B wrote the reply you would keep' },
  { verdict: 'tie', label: 'Tie', hint: 'Both are good, and equally so' },
  {
    verdict: 'bad',
    label: 'Both bad',
    hint: 'Neither is usable. Recorded, but it moves no ratings — it says nothing about which is better.',
  },
];

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
  sessionRounds,
}: BlindRoundProps) {
  const current = run.state.runs[0] ?? null;
  const settled = current ? isRunSettled(current) : false;
  const hold = settings.holdBlindUntilComplete && !settled;
  const character = current
    ? characters.find((entry) => entry.avatar === current.characterId)
    : null;

  return (
    <div className="arena-blind">
      <header className="arena-blind__head">
        <div className="arena-blind__scene">
          {current ? (
            <>
              <img
                className="arena-run__avatar"
                src={characterApi.imageUrl(current.characterId)}
                alt=""
              />
              <div>
                <span className="arena-run__character">
                  {character?.name ?? current.characterId}
                </span>
                <p className="arena-run__probe">{current.probe}</p>
              </div>
            </>
          ) : (
            <p className="wc-hint">
              Each round draws a card, a probe and two contenders from your pools. You read both
              replies and pick one; only then do you find out who wrote them.
            </p>
          )}
        </div>

        <div className="arena-blind__actions">
          <span className="arena-blind__count">
            {sessionRounds === 0
              ? null
              : `${sessionRounds} judged this sitting · ${sessionRounds * 2} generations`}
          </span>
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
              disabled={Boolean(blockedReason) || (Boolean(current) && !revealed)}
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
          <div className="arena-run__columns" style={{ '--wc-arena-columns': 2 } as never}>
            {current.entries.map((entry, index) => (
              <ContenderColumn
                key={entry.contenderId}
                entry={entry}
                stream={run.streams[index] ?? null}
                display={displayFor(current.characterId)}
                masked={!revealed}
                maskLabel={index === 0 ? 'A' : 'B'}
                hold={hold}
              />
            ))}
          </div>

          <div className="arena-vote">
            {revealed ? (
              <p className="arena-vote__reveal">
                {/* The draw, not the run entries: the entries carry the labels, but reading
                    the reveal off the draw is what proves the two never disagreed. */}
                <strong>A</strong> was {draw ? labelOf(draw, 0) : '—'} · <strong>B</strong> was{' '}
                {draw ? labelOf(draw, 1) : '—'}
              </p>
            ) : (
              VOTES.map((vote) => (
                <button
                  key={vote.verdict}
                  type="button"
                  className={
                    vote.verdict === 'bad'
                      ? 'wc-button wc-button--ghost'
                      : 'wc-button wc-button--primary'
                  }
                  onClick={() => onVote(vote.verdict)}
                  disabled={!settled || recording}
                  title={settled ? vote.hint : 'Both replies are still being written'}
                >
                  {vote.label}
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
