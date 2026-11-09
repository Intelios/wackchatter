/**
 * Tournaments: brackets drawn as a poster.
 *
 * The list sits on the left with the career points under it; the bracket is the page, one
 * column per stage with its name set large, and the winner of each match carries a lime edge
 * forward. A match is fought in the blind room's duel: a tie or "both bad" re-rolls both
 * sides once, and after that one of them has to win.
 */

import {
  activeProbes,
  TOURNAMENT_SIZES,
  type TournamentSize,
  type TournamentStage,
  type TournamentWithMatches,
  tournamentStagePoints,
  tournamentStages,
} from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useEffect, useState } from 'react';
import { isRunSettled } from '../features/arena/state/arenaReducer.ts';
import { bracketView, seedEntrants, stageName } from '../features/arena/tournament/bracket.ts';
import type { ArenaController } from '../features/arena/useArena.ts';
import { characterApi } from '../lib/api.ts';
import { Duel, type SideReveal, useDuelKeys } from './ArenaDuel.tsx';
import { CardPicker, Cue } from './ArenaRoom.tsx';
import type { PriceOf } from './arenaStats.ts';
import { useArm } from './controls.tsx';
import { Icon } from './icons.tsx';

function cardName(characters: readonly CharacterSummary[], id: string): string {
  return characters.find((c) => c.avatar === id)?.name ?? id.replace(/\.png$/i, '');
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function ArenaTournaments({
  arena,
  characters,
  nameOf,
  priceOf,
}: {
  arena: ArenaController;
  characters: readonly CharacterSummary[];
  nameOf: (id: string) => string;
  priceOf: PriceOf;
}) {
  const [creating, setCreating] = useState(false);
  const { tournaments, tournamentId, setTournamentId } = arena;

  // Open the newest bracket rather than an empty page.
  useEffect(() => {
    if (tournamentId || creating || tournaments.length === 0) return;
    const latest = [...tournaments].sort((a, b) => b.created - a.created)[0];
    if (latest) setTournamentId(latest.id);
  }, [tournamentId, creating, tournaments, setTournamentId]);

  // The engine says "contenders"; the screen calls them models in the pool.
  const blockedReason = arena.tournamentBlockedReason
    ? /contenders/.test(arena.tournamentBlockedReason)
      ? `A tournament needs at least 4 models switched on in the pool. You have ${arena.eligible.length}.`
      : arena.tournamentBlockedReason
    : null;
  const selected = tournaments.find((t) => t.id === tournamentId) ?? null;
  const inPool = new Set(arena.settings.contenders.map((c) => c.id));
  // Pool models by their short name; a model since removed by what the bracket recorded.
  const label = (id: string) => (inPool.has(id) ? nameOf(id) : arena.nameFor(id));

  return (
    <div className="w3-ar-scroll">
      <div className="w3-ar-tour">
        <aside className="w3-ar-tlist">
          <p className="w3-ar-label">Tournaments</p>
          {[...tournaments]
            .sort((a, b) => b.created - a.created)
            .map((t) => {
              const view = bracketView(t);
              const status = view.championId
                ? `Won by ${label(view.championId)} · ${shortDate(t.created)}`
                : t.status === 'abandoned'
                  ? 'Stopped'
                  : `${t.size} models · ${view.next ? stageName(t.size, view.next.stage) : 'under way'}`;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-current={!creating && t.id === tournamentId ? 'true' : undefined}
                  onClick={() => {
                    setCreating(false);
                    setTournamentId(t.id);
                  }}
                >
                  <b>{t.name}</b>
                  <small>{status}</small>
                </button>
              );
            })}
          <button
            type="button"
            className="w3-ar-tlist__new"
            disabled={Boolean(blockedReason)}
            title={blockedReason ?? 'Start a bracket'}
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" size="sm" />
            New tournament
          </button>
          {arena.careerLadder.some((row) => row.points > 0) ? (
            <div className="w3-ar-ladder">
              <p className="w3-ar-label">Career points</p>
              {arena.careerLadder
                .filter((row) => row.points > 0)
                .slice(0, 8)
                .map((row, i) => (
                  <div key={row.contenderId} className="w3-ar-ladder__row">
                    <span className="w3-ar-rank">{i + 1}</span>
                    <span>{label(row.contenderId)}</span>
                    <span className="w3-ar-num" title={`${row.titles} titles, ${row.wins} wins`}>
                      {row.points}
                    </span>
                  </div>
                ))}
            </div>
          ) : null}
        </aside>

        <div className="w3-ar-tmain">
          {creating ? (
            <Wizard
              arena={arena}
              characters={characters}
              label={label}
              onCancel={() => setCreating(false)}
              onCreated={() => setCreating(false)}
            />
          ) : arena.matchRun && selected && arena.matchRun.tournamentId === selected.id ? (
            <MatchRoom
              arena={arena}
              tournament={selected}
              characters={characters}
              label={label}
              priceOf={priceOf}
            />
          ) : selected ? (
            <Poster arena={arena} tournament={selected} characters={characters} label={label} />
          ) : (
            <div className="w3-ar-start">
              <h2>No tournaments yet</h2>
              <p>
                Four, eight or sixteen models, knocked out blind, stage by stage. Points double each
                stage.
              </p>
              <button
                type="button"
                className="w3-st-pill"
                disabled={Boolean(blockedReason)}
                title={blockedReason ?? undefined}
                onClick={() => setCreating(true)}
              >
                New tournament
              </button>
              {blockedReason ? <p className="w3-ar-faint">{blockedReason}</p> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- The poster ----------

function Poster({
  arena,
  tournament,
  characters,
  label,
}: {
  arena: ArenaController;
  tournament: TournamentWithMatches;
  characters: readonly CharacterSummary[];
  label: (id: string) => string;
}) {
  const arm = useArm();
  const view = bracketView(tournament);
  const [renaming, setRenaming] = useState<string | null>(null);
  const stages = tournamentStages(tournament.size);
  const startReason = arena.startBlockedReason(tournament);

  return (
    <div className="w3-ar-poster">
      <header className="w3-ar-poster__h">
        <div>
          {renaming !== null ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (renaming.trim()) void arena.renameTournament(tournament.id, renaming.trim());
                setRenaming(null);
              }}
            >
              <input
                className="w3-ar-poster__rename"
                value={renaming}
                aria-label="Tournament name"
                // biome-ignore lint/a11y/noAutofocus: opened to type into
                autoFocus
                onChange={(event) => setRenaming(event.target.value)}
                onBlur={() => setRenaming(null)}
              />
            </form>
          ) : (
            <h1>{tournament.name}</h1>
          )}
          <p>
            {tournament.size} models · {stages} stages · points double each stage · started{' '}
            {shortDate(tournament.created)}
            {tournament.status === 'abandoned' ? ' · stopped' : ''}
          </p>
        </div>
        <span className="w3-ar-gap" />
        <button
          type="button"
          className="w3-st-ghost w3-st-ghost--sm"
          onClick={() => setRenaming(tournament.name)}
        >
          Rename
        </button>
        {view.complete ? null : tournament.status === 'active' ? (
          <button
            type="button"
            className="w3-st-ghost w3-st-ghost--sm"
            onClick={() => void arena.abandonTournament(tournament.id)}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="w3-st-ghost w3-st-ghost--sm"
            onClick={() => void arena.resumeTournament(tournament.id)}
          >
            Resume
          </button>
        )}
        <button
          type="button"
          className="w3-st-ghost w3-st-ghost--sm"
          data-armed={arm.armed === 'delete' ? '' : undefined}
          onClick={() => arm.press('delete', () => void arena.deleteTournament(tournament.id))}
        >
          {arm.armed === 'delete' ? 'Delete it and its matches?' : 'Delete'}
        </button>
      </header>

      {arena.matchError ? <p className="w3-ar-problem">{arena.matchError}</p> : null}

      <div className="w3-ar-bracket" style={{ ['--stages' as string]: stages }}>
        {view.stages.map((slots, stage) => {
          const plan = tournament.stages[stage];
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: stages are positional
            <section key={stage} className="w3-ar-stage">
              <header className="w3-ar-stage__name">
                {stageName(tournament.size, stage)}
                <small>
                  {plan ? cardName(characters, plan.characterId) : ''} ·{' '}
                  {tournamentStagePoints(stage)} {tournamentStagePoints(stage) === 1 ? 'pt' : 'pts'}
                </small>
              </header>
              <div className="w3-ar-stage__col">
                {slots.map((slot) => {
                  const playable =
                    !slot.match && slot.leftId && slot.rightId && tournament.status === 'active';
                  const blocked = playable
                    ? (startReason ??
                      arena.entrantBlockedReason(tournament.id, slot.stage, slot.matchIndex))
                    : null;
                  const side = (id: string | null, which: 'left' | 'right') => {
                    const won = slot.winnerId !== null && slot.winnerId === id;
                    const lost = slot.winnerId !== null && slot.winnerId !== id;
                    return (
                      <div
                        data-won={won ? '' : undefined}
                        data-lost={lost ? '' : undefined}
                        data-tbd={id ? undefined : ''}
                      >
                        {id
                          ? label(id)
                          : stage === 0
                            ? '—'
                            : `Winner of match ${slot.matchIndex * 2 + (which === 'left' ? 1 : 2)}`}
                      </div>
                    );
                  };
                  return (
                    <div
                      key={slot.matchIndex}
                      className="w3-ar-match"
                      data-next={playable ? '' : undefined}
                    >
                      {side(slot.leftId, 'left')}
                      {side(slot.rightId, 'right')}
                      {playable ? (
                        <button
                          type="button"
                          className="w3-st-pill w3-ar-fight"
                          disabled={Boolean(blocked)}
                          title={blocked ?? 'Fight this match blind'}
                          onClick={() =>
                            arena.startTournamentMatch(tournament.id, slot.stage, slot.matchIndex)
                          }
                        >
                          Fight · blind
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
        <section className="w3-ar-champ" data-won={view.championId ? '' : undefined}>
          <Icon name="arena" />
          <b>{view.championId ? label(view.championId) : 'Champion'}</b>
          <small>
            {view.championId
              ? `${tournamentStagePoints(stages - 1)} points for the final`
              : `${view.playedMatches} of ${view.totalMatches} matches played`}
          </small>
        </section>
      </div>
      <p className="w3-ar-faint">
        Matches are blind. A tie or “both bad” re-rolls both replies once; after that one of them
        has to win.
      </p>
    </div>
  );
}

// ---------- A match ----------

function MatchRoom({
  arena,
  tournament,
  characters,
  label,
  priceOf,
}: {
  arena: ArenaController;
  tournament: TournamentWithMatches;
  characters: readonly CharacterSummary[];
  label: (id: string) => string;
  priceOf: PriceOf;
}) {
  const match = arena.matchRun!;
  const run = arena.tournamentRun;
  const current = run.state.runs[0] ?? null;
  const settled = current ? isRunSettled(current) : false;
  const bothDone = current?.entries.every((e) => e.status === 'done') ?? false;
  const canVote =
    Boolean(current) && settled && bothDone && !arena.matchRevealed && !arena.matchRecording;
  const [verdict, setVerdict] = useState<'left' | 'right' | null>(null);
  const vote = (v: 'left' | 'right' | 'tie' | 'bad') => {
    if (!canVote) return;
    if (v === 'left' || v === 'right') setVerdict(v);
    arena.voteMatch(v);
  };
  const back = () => {
    setVerdict(null);
    arena.exitMatch();
  };
  useDuelKeys({
    canVote,
    ties: !match.deadHeat,
    onVote: vote,
    canNext: arena.matchRevealed && !arena.matchRecording,
    onNext: back,
    busy: run.busy,
    onStop: run.abort,
  });

  const plan = tournament.stages[match.stage];
  const points = tournamentStagePoints(match.stage);
  const reveals: [SideReveal, SideReveal] | null =
    arena.matchRevealed && current
      ? (match.sides.map((id, index) => ({
          name: label(id),
          sub:
            current.entries[index]?.model +
            ((index === 0 ? verdict === 'left' : verdict === 'right')
              ? ` · +${points} ${points === 1 ? 'point' : 'points'}`
              : ''),
          before: null,
          after: null,
        })) as [SideReveal, SideReveal])
      : null;

  return (
    <div className="w3-ar-room w3-ar-room--match">
      <div className="w3-ar-scene">
        {plan ? (
          <img className="w3-ar-scene__face" src={characterApi.imageUrl(plan.characterId)} alt="" />
        ) : null}
        <div className="w3-ar-scene__cue">
          <small>
            {tournament.name} · {stageName(tournament.size, match.stage)}
            {plan ? ` · ${cardName(characters, plan.characterId)}` : ''}
            {match.deadHeat ? ' · re-rolled, one of them must win' : ''}
          </small>
          <p>
            {plan ? (
              <Cue
                text={plan.cue.replace(/\{\{char\}\}/gi, cardName(characters, plan.characterId))}
              />
            ) : null}
          </p>
        </div>
        <button
          type="button"
          className="w3-st-ghost w3-st-ghost--sm"
          onClick={back}
          disabled={run.busy}
        >
          Back to the bracket
        </button>
      </div>
      {run.error ? <p className="w3-ar-problem">{run.error}</p> : null}
      {arena.matchError ? <p className="w3-ar-problem">{arena.matchError}</p> : null}
      {current ? (
        <Duel
          entries={current.entries}
          streams={run.streams}
          display={arena.displayFor(current.characterId)}
          masked={!arena.matchRevealed}
          hold={arena.settings.holdBlindUntilComplete}
          canVote={canVote}
          verdict={arena.matchRevealed ? verdict : null}
          reveals={reveals}
          priceOf={priceOf}
          ties={!match.deadHeat}
          onVote={arena.matchRevealed ? null : vote}
          onRetry={(id) => void run.rerollColumn(current.id, id)}
        />
      ) : (
        <div className="w3-ar-start">
          <p>Preparing the match…</p>
        </div>
      )}
      <footer className="w3-ar-foot">
        {arena.matchRevealed ? (
          <>
            <span className="w3-ar-faint">{arena.matchRecording ? 'Recording…' : 'Recorded.'}</span>
            <button
              type="button"
              className="w3-st-pill w3-ar-big"
              disabled={arena.matchRecording}
              onClick={back}
            >
              Back to the bracket
              <kbd className="w3-kbd">↵</kbd>
            </button>
          </>
        ) : run.busy ? (
          <button type="button" className="w3-st-ghost" onClick={run.abort}>
            <Icon name="stop" size="sm" />
            Stop <kbd className="w3-kbd">Esc</kbd>
          </button>
        ) : (
          <span className="w3-ar-keys">
            <span>
              <kbd className="w3-kbd">1</kbd> A
            </span>
            <span>
              <kbd className="w3-kbd">2</kbd> B
            </span>
            {match.deadHeat ? null : (
              <>
                <span>
                  <kbd className="w3-kbd">3</kbd> Tie, re-roll
                </span>
                <span>
                  <kbd className="w3-kbd">4</kbd> Both bad, re-roll
                </span>
              </>
            )}
          </span>
        )}
      </footer>
    </div>
  );
}

// ---------- A new bracket ----------

function Wizard({
  arena,
  characters,
  label,
  onCancel,
  onCreated,
}: {
  arena: ArenaController;
  characters: readonly CharacterSummary[];
  label: (id: string) => string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const eligible = arena.eligible.map((c) => c.id);
  const pick = (size: number) => seedEntrants(eligible, crypto.randomUUID()).slice(0, size);
  const [size, setSize] = useState<TournamentSize>(eligible.length >= 8 ? 8 : 4);
  const [name, setName] = useState('Model Cup');
  const [entrants, setEntrants] = useState<string[]>(() => pick(eligible.length >= 8 ? 8 : 4));
  const cues = activeProbes(arena.settings.probes);
  const blank = (n: TournamentSize): TournamentStage[] =>
    Array.from({ length: tournamentStages(n) }, (_, i) => ({
      characterId:
        arena.drawableCards[i % Math.max(1, arena.drawableCards.length)] ??
        characters[0]?.avatar ??
        '',
      cue: cues[i % Math.max(1, cues.length)]?.text ?? '',
    }));
  const [plans, setPlans] = useState<TournamentStage[]>(() => blank(eligible.length >= 8 ? 8 : 4));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked =
    eligible.length < size
      ? `You need ${size} models switched on in the pool.`
      : entrants.length !== size
        ? `Pick exactly ${size} models.`
        : !name.trim()
          ? 'Give it a name.'
          : plans.some((p) => !p.characterId || !p.cue.trim())
            ? 'Every stage needs a character and a cue.'
            : null;

  return (
    <div className="w3-ar-wizard">
      <header className="w3-ar-poster__h">
        <div>
          <h1>New tournament</h1>
          <p>
            {size} models, {size - 1} matches, {2 * (size - 1)} replies. Every stage asks its own
            character and cue.
          </p>
        </div>
      </header>

      <section className="w3-ar-wsec">
        <p className="w3-ar-label">Size</p>
        <div className="w3-ar-chips">
          {TOURNAMENT_SIZES.map((n) => (
            <button
              key={n}
              type="button"
              className="w3-ar-chip"
              aria-pressed={size === n}
              disabled={eligible.length < n}
              title={eligible.length < n ? `Needs ${n} models in the pool` : undefined}
              onClick={() => {
                setSize(n);
                setEntrants(pick(n));
                setPlans(blank(n));
              }}
            >
              {n} models
            </button>
          ))}
        </div>
      </section>

      <section className="w3-ar-wsec">
        <p className="w3-ar-label">
          Who's in · {entrants.length} of {size}
          <button type="button" className="w3-ar-quiet" onClick={() => setEntrants(pick(size))}>
            Pick at random
          </button>
        </p>
        <div className="w3-ar-chips">
          {eligible.map((id) => {
            const on = entrants.includes(id);
            return (
              <button
                key={id}
                type="button"
                className="w3-ar-chip"
                aria-pressed={on}
                disabled={!on && entrants.length >= size}
                onClick={() =>
                  setEntrants(on ? entrants.filter((x) => x !== id) : [...entrants, id])
                }
              >
                {label(id)}
              </button>
            );
          })}
        </div>
      </section>

      <section className="w3-ar-wsec">
        <p className="w3-ar-label">Stages</p>
        {plans.map((plan, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stages are positional
          <div key={i} className="w3-ar-wstage">
            <b>
              {stageName(size, i)}
              <small>
                {tournamentStagePoints(i)} {tournamentStagePoints(i) === 1 ? 'pt' : 'pts'}
              </small>
            </b>
            <CardPicker
              characters={characters}
              value={plan.characterId || null}
              onPick={(avatar) =>
                setPlans(plans.map((p, at) => (at === i ? { ...p, characterId: avatar } : p)))
              }
            />
            <textarea
              value={plan.cue}
              rows={2}
              placeholder="The cue both models answer"
              aria-label={`${stageName(size, i)} cue`}
              onChange={(event) =>
                setPlans(plans.map((p, at) => (at === i ? { ...p, cue: event.target.value } : p)))
              }
            />
            {arena.settings.probes.length ? (
              <div className="w3-ar-chips w3-ar-chips--sm">
                {arena.settings.probes.slice(0, 6).map((probe) => (
                  <button
                    key={probe.id}
                    type="button"
                    className="w3-ar-chip"
                    title={probe.text}
                    onClick={() =>
                      setPlans(plans.map((p, at) => (at === i ? { ...p, cue: probe.text } : p)))
                    }
                  >
                    {probe.text.slice(0, 32)}
                    {probe.text.length > 32 ? '…' : ''}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </section>

      <section className="w3-ar-wsec">
        <p className="w3-ar-label">Name</p>
        <input
          className="w3-ar-wname"
          value={name}
          aria-label="Tournament name"
          onChange={(event) => setName(event.target.value)}
        />
      </section>

      {error ? <p className="w3-ar-problem">{error}</p> : null}
      <div className="w3-ar-wfoot">
        <button type="button" className="w3-st-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="w3-st-pill"
          disabled={Boolean(blocked) || busy}
          title={blocked ?? undefined}
          onClick={() => {
            setBusy(true);
            setError(null);
            void arena
              .createTournament({
                name: name.trim(),
                size,
                entrants: seedEntrants(entrants, crypto.randomUUID()),
                stages: plans.map((p) => ({ characterId: p.characterId, cue: p.cue.trim() })),
              })
              .then(onCreated)
              .catch((err) => setError((err as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          Draw the bracket
        </button>
      </div>
    </div>
  );
}
