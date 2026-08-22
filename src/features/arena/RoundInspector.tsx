/**
 * One recorded round, reopened.
 *
 * Possible with no new persistence at all: `RoundSide` already stores the full text of both
 * replies, because it stores what actually happened rather than a summary of it. So the
 * question "why did I vote that way at round nine?" — previously unanswerable — is a click
 * on the tick for round nine.
 *
 * The identities are shown, obviously: the blind is over, the verdict is recorded, and there
 * is nothing left to protect. What is shown *first* is still the two replies, in the same
 * order they were judged in, so re-reading it feels like the round rather than like a
 * database row.
 */

import type { ArenaRound } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import { CloseIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { Markdown } from '../chat/Markdown.tsx';
import type { ArenaDisplay } from './display.ts';
import { colourOf } from './series.ts';

interface RoundInspectorProps {
  round: ArenaRound;
  characters: readonly CharacterSummary[];
  colours: ReadonlyMap<string, string>;
  nameOf: (contenderId: string, model: string) => string;
  displayFor: (characterId: string) => ArenaDisplay;
  /** Which round this is in the history, one-based. */
  number: number;
  onClose: () => void;
}

const OUTCOME: Record<ArenaRound['verdict'], string> = {
  left: 'A won',
  right: 'B won',
  tie: 'A tie',
  bad: 'Both rejected — this round moved no ratings',
};

export function RoundInspector({
  round,
  characters,
  colours,
  nameOf,
  displayFor,
  number,
  onClose,
}: RoundInspectorProps) {
  const character = characters.find((entry) => entry.avatar === round.characterId);
  const display = displayFor(round.characterId);

  // Escape closes it. Not a modal — the leaderboard behind stays readable and scrollable —
  // but Escape is what everyone reaches for, and the app has no dialog convention to borrow.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const sides = [
    { label: 'A', side: round.left, won: round.verdict === 'left' },
    { label: 'B', side: round.right, won: round.verdict === 'right' },
  ];

  return (
    <section className="arena-inspector" aria-label={`Round ${number}`}>
      <header className="arena-inspector__head">
        <img
          className="arena-inspector__avatar"
          src={characterApi.imageUrl(round.characterId)}
          alt=""
        />
        <div className="arena-inspector__scene">
          <span className="arena-inspector__title">
            Round {number} · {character?.name ?? round.characterId}
          </span>
          <p className="arena-inspector__probe">{round.probe}</p>
        </div>
        <span className="arena-inspector__verdict" data-verdict={round.verdict}>
          {OUTCOME[round.verdict]}
        </span>
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={onClose}
          aria-label="Close this round"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="arena-inspector__sides">
        {sides.map(({ label, side, won }) => (
          <article
            key={label}
            className="arena-inspector__side"
            data-won={won}
            style={{ '--wc-corner': colourOf(colours, side.contenderId) } as CSSProperties}
          >
            <header className="arena-inspector__who">
              <span className="arena-inspector__label">{label}</span>
              <span className="arena-inspector__name">{nameOf(side.contenderId, side.model)}</span>
              <span className="arena-inspector__model" title={`${side.provider} · ${side.model}`}>
                {side.model || '—'}
              </span>
            </header>
            {side.text ? (
              <Markdown text={display.output(side.text)} className="arena-inspector__text" />
            ) : (
              <p className="arena-column__empty">Nothing came back.</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
