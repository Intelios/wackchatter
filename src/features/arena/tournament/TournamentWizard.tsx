/**
 * Creating a tournament.
 *
 * Four decisions in one linear form: the size, who is in it, the card and cue each stage
 * asks, and a name. Everything is fixed here — the plan is not editable after creation —
 * so the form refuses to submit until every stage has both a card and a cue, and the reason
 * is the button's title rather than a toast (the app's "disabled beats refused" rule).
 *
 * Seeding is random: the user chooses *who* enters, `seedEntrants` decides where they land.
 * The bracket screen draws the order that produced, so a surprising draw is visible rather
 * than something to take on faith.
 */

import type {
  ArenaProbe,
  Contender,
  TournamentSize,
  TournamentStage,
} from '@shared/types/arena.ts';
import { TOURNAMENT_SIZES, tournamentStages } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useRef, useState } from 'react';
import { seedEntrants, stageName } from './bracket.ts';
import { SavedCuePicker } from './SavedCuePicker.tsx';

interface TournamentWizardProps {
  /** Enabled, runnable contenders — the same set the blind draw considers. */
  eligible: readonly Contender[];
  characters: readonly CharacterSummary[];
  /** The Pool's saved cues, offered for any stage rather than retyped. */
  probes: readonly ArenaProbe[];
  /** How to name a contender: its own name, or the model its endpoint will serve. */
  labelFor: (contenderId: string) => string;
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    size: TournamentSize;
    entrants: string[];
    stages: TournamentStage[];
  }) => Promise<void>;
}

function pickRandom(eligible: readonly Contender[], size: number): string[] {
  return seedEntrants(
    eligible.map((entry) => entry.id),
    crypto.randomUUID(),
  ).slice(0, size);
}

function blankPlans(
  size: TournamentSize,
  characters: readonly CharacterSummary[],
): TournamentStage[] {
  const fallbackCard = characters[0]?.avatar ?? '';
  return Array.from({ length: tournamentStages(size) }, () => ({
    characterId: fallbackCard,
    cue: '',
  }));
}

export function TournamentWizard({
  eligible,
  characters,
  probes,
  labelFor,
  onCancel,
  onCreate,
}: TournamentWizardProps) {
  const [size, setSize] = useState<TournamentSize>(() => (eligible.length >= 8 ? 8 : 4));
  const [name, setName] = useState('Model Cup');
  const [selected, setSelected] = useState<string[]>(() => pickRandom(eligible, size));
  const [plans, setPlans] = useState<TournamentStage[]>(() => blankPlans(size, characters));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The stage cue fields, so a picked cue lands the caret in the field it just filled. */
  const cueRefs = useRef(new Map<number, HTMLTextAreaElement>());

  const pickCue = (index: number, text: string) => {
    setPlan(index, { cue: text });
    // The popup unmounts on the pick, so focus waits one tick for the close to render —
    // the same rule Popover uses to restore focus to its trigger on Escape.
    window.setTimeout(() => cueRefs.current.get(index)?.focus({ preventScroll: true }), 0);
  };

  const chooseSize = (next: TournamentSize) => {
    setSize(next);
    setSelected(pickRandom(eligible, next));
    setPlans(blankPlans(next, characters));
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id);
      if (current.length >= size) return current;
      return [...current, id];
    });
  };

  const setPlan = (index: number, patch: Partial<TournamentStage>) => {
    setPlans((current) =>
      current.map((stage, position) => (position === index ? { ...stage, ...patch } : stage)),
    );
  };

  const stageNameOf = (index: number) => stageName(size, index);

  const blocked = (() => {
    if (eligible.length < size) return `You need ${size} enabled, runnable contenders.`;
    if (characters.length === 0) return 'Add a character card first.';
    if (selected.length !== size) return `Choose exactly ${size} contenders.`;
    if (!name.trim()) return 'Give the tournament a name.';
    const missing = plans.findIndex((stage) => !stage.characterId || !stage.cue.trim());
    if (missing >= 0)
      return `Every stage needs a card and a cue — ${stageNameOf(missing)} is empty.`;
    return null;
  })();

  const submit = () => {
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    void onCreate({
      name: name.trim(),
      size,
      // Random bracket-slot order, drawn once. The plan stores this order, so re-opening the
      // tournament shows the bracket it actually ran rather than a fresh shuffle.
      entrants: seedEntrants(selected, crypto.randomUUID()),
      stages: plans.map((stage) => ({ characterId: stage.characterId, cue: stage.cue.trim() })),
    })
      .catch((err) => setError((err as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="arena-tour arena-tour--wizard">
      <header className="arena-tour__head">
        <div>
          <h2 className="arena-tour__title">New tournament</h2>
          <p className="arena-tour__blurb">
            {size} contenders, {size - 1} matches, {2 * (size - 1)} generations. Every stage asks
            its own card and cue.
          </p>
        </div>
        <button type="button" className="wc-button wc-button--ghost" onClick={onCancel}>
          Cancel
        </button>
      </header>

      <section className="arena-tour__step">
        <h3 className="arena-tour__grouptitle">1 · Size</h3>
        <div className="arena-tour__sizes">
          {TOURNAMENT_SIZES.map((option) => (
            <button
              key={option}
              type="button"
              className="wc-button"
              aria-pressed={size === option}
              disabled={eligible.length < option}
              title={
                eligible.length < option
                  ? `You have ${eligible.length} eligible contenders`
                  : `${option} contenders`
              }
              onClick={() => chooseSize(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <section className="arena-tour__step">
        <h3 className="arena-tour__grouptitle">
          2 · Contenders{' '}
          <span className="arena-tour__count">
            {selected.length} / {size}
          </span>
        </h3>
        <div className="arena-tour__entrants">
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => setSelected(pickRandom(eligible, size))}
          >
            Redraw at random
          </button>
          <ul className="arena-tour__entrantlist">
            {eligible.map((entry) => {
              const on = selected.includes(entry.id);
              return (
                <li key={entry.id}>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && selected.length >= size}
                      onChange={() => toggle(entry.id)}
                    />
                    <span>{labelFor(entry.id)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {eligible.length === 0 ? (
            <p className="wc-empty">No enabled contenders. Add some in Pool.</p>
          ) : null}
        </div>
      </section>

      <section className="arena-tour__step">
        <h3 className="arena-tour__grouptitle">3 · Stage cards and cues</h3>
        <div className="arena-tour__plans">
          {plans.map((plan, index) => (
            // Stage plans are positional and never reordered, so the index is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: stage order is the identity
            <div className="arena-tour__plan" key={index}>
              <h4>{stageNameOf(index)}</h4>

              <label className="wc-label">
                Card
                <select
                  className="wc-select"
                  value={plan.characterId}
                  onChange={(event) => setPlan(index, { characterId: event.target.value })}
                >
                  {characters.length === 0 ? <option value="">No cards</option> : null}
                  {characters.map((character) => (
                    <option key={character.avatar} value={character.avatar}>
                      {character.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="arena-tour__cuetop">
                <span className="wc-label">Cue</span>
                <SavedCuePicker
                  probes={probes}
                  stageLabel={stageNameOf(index)}
                  onPick={(text) => pickCue(index, text)}
                />
              </div>
              <textarea
                ref={(node) => {
                  if (node) cueRefs.current.set(index, node);
                  else cueRefs.current.delete(index);
                }}
                className="wc-input arena-tour__cue"
                rows={2}
                value={plan.cue}
                aria-label={`Cue for ${stageNameOf(index)}`}
                placeholder="What you say to the character in this stage"
                onChange={(event) => setPlan(index, { cue: event.target.value })}
              />
              <p className="wc-hint">Macros like {'{{char}}'} resolve against the card.</p>
            </div>
          ))}
        </div>
      </section>

      <section className="arena-tour__step">
        <h3 className="arena-tour__grouptitle">4 · Name</h3>
        <input
          className="wc-input"
          value={name}
          aria-label="Tournament name"
          onChange={(event) => setName(event.target.value)}
        />
      </section>

      {error ? (
        <p className="arena-error" role="alert">
          {error}
        </p>
      ) : null}

      <footer className="arena-tour__create">
        <button
          type="button"
          className="wc-button wc-button--primary"
          disabled={blocked !== null || busy}
          title={blocked ?? 'Draw the bracket'}
          onClick={submit}
        >
          {busy ? 'Creating…' : 'Create tournament'}
        </button>
        {blocked ? <span className="arena-tour__blocked">{blocked}</span> : null}
      </footer>
    </div>
  );
}
