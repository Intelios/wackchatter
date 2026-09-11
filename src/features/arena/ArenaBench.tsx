/**
 * The open Arena: a test bench.
 *
 * You choose the card, you choose who runs, you write the cue, and every reply is labelled.
 * Nothing here is scored — a comparison where you knew which one was which is not evidence
 * about which is better, and the leaderboard only ever hears from blind rounds.
 *
 * Runs stack, newest first. Each one is independent: the same scene, a different cue, and no
 * reply ever feeds into the next. That is the whole difference between this and a chat, and
 * it is why run five is as comparable as run one.
 *
 * The setup is a masthead rather than a column of form rows, because the three facts it
 * carries — who is in each corner, what they are rated, and which card they are playing —
 * are the whole question the screen is asking. They were previously three grey
 * `<select>`s labelled "Character", "Columns" and nothing at all, with the ratings the app
 * already knew nowhere on screen at the exact moment you were choosing between them.
 */

import type { ArenaProbe, ArenaSettings } from '@shared/types/arena.ts';
import { ARENA_MAX_COLUMNS, ARENA_MIN_COLUMNS } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CloseIcon,
  ExpandIcon,
  RefreshIcon,
  SendIcon,
  ShrinkIcon,
  StopIcon,
} from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { CharacterPicker } from './CharacterPicker.tsx';
import { ContenderColumn } from './ContenderColumn.tsx';
import { CornerPicker } from './CornerPicker.tsx';
import { CueField } from './CueField.tsx';
import type { ResolvedContender } from './contenders.ts';
import type { ArenaDisplay } from './display.ts';
import type { LeaderboardRow } from './elo.ts';
import { columnLeaders, lengthRatios } from './runStats.ts';
import { viewSeries } from './series.ts';
import { isRunSettled } from './state/arenaReducer.ts';
import type { UseArenaRun } from './useArenaRun.ts';

interface ArenaBenchProps {
  settings: ArenaSettings;
  onSettingsChange: (patch: Partial<ArenaSettings>) => void;
  characters: readonly CharacterSummary[];
  resolved: readonly ResolvedContender[];
  run: UseArenaRun;
  /** The card currently staged, and how to stage another. */
  characterId: string | null;
  onSelectCharacter: (avatar: string) => void;
  /** Null until the staged card's detail and lore have loaded. */
  ready: boolean;
  readyReason: string | null;
  displayFor: (characterId: string) => ArenaDisplay;
  onRun: (probe: string, contenderIds: string[], characterId: string) => void;
  /** Why running is impossible right now. Null when it is possible. */
  blockedReason: string | null;
  /** Records for the masthead, replayed from the recorded rounds by the shell. */
  rows: readonly LeaderboardRow[];
  /**
   * Contender id → the id its rounds count under, from the shell's merged view.
   *
   * The masthead shows the record the app already knew for an entrant, and a folded
   * contender has no row of its own — resolving through this is what stops the corner from
   * reporting "no blind rounds yet" for a model whose rounds are on the board under the
   * identity that absorbed it.
   */
  canonical: ReadonlyMap<string, string>;
  /** Preferred corner colours, by pool order. Resolved per view — see series.ts. */
  preferredSlots: ReadonlyMap<string, number>;
  /** Whether the canvas is currently widened, and how to change it. */
  wide: boolean;
  onWideChange: (wide: boolean) => void;
}

export function ArenaBench({
  settings,
  onSettingsChange,
  characters,
  resolved,
  run,
  characterId,
  onSelectCharacter,
  ready,
  readyReason,
  displayFor,
  onRun,
  blockedReason,
  rows,
  canonical,
  preferredSlots,
  wide,
  onWideChange,
}: ArenaBenchProps) {
  const [probe, setProbe] = useState('');
  const [picks, setPicks] = useState<string[]>([]);
  /** The one run showing on its own, or null for the whole log. */
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);

  const usable = useMemo(() => resolved.filter((entry) => entry.connection !== null), [resolved]);

  const columns = Math.min(
    ARENA_MAX_COLUMNS,
    Math.max(ARENA_MIN_COLUMNS, settings.columns || ARENA_MIN_COLUMNS),
  );

  /*
   * Keep one pick per column, defaulting each slot to a different contender.
   *
   * Re-derived rather than stored in settings: which two you are comparing right now is a
   * this-minute decision, not a preference, and writing it through on every change would
   * put a settings round-trip in the way of a dropdown.
   */
  useEffect(() => {
    setPicks((current) => {
      const next: string[] = [];
      for (let index = 0; index < columns; index++) {
        const existing = current[index];
        const stillUsable = existing && usable.some((entry) => entry.contender.id === existing);
        // A slot keeps its pick; an empty or stale one takes the first contender not
        // already on screen, so opening the bench never shows the same model twice.
        next.push(
          stillUsable
            ? existing
            : (usable.find((entry) => !next.includes(entry.contender.id))?.contender.id ?? ''),
        );
      }
      return next.every((value, index) => value === current[index]) &&
        next.length === current.length
        ? current
        : next;
    });
  }, [columns, usable]);

  const chosen = picks.filter(Boolean);
  const duplicate = new Set(chosen).size !== chosen.length;

  const runReason =
    blockedReason ??
    (!characterId ? 'Choose a character first.' : null) ??
    (!ready ? readyReason : null) ??
    (chosen.length < ARENA_MIN_COLUMNS ? 'Choose at least two contenders.' : null) ??
    (duplicate ? 'Two columns are running the same contender.' : null) ??
    (!probe.trim() ? 'Write a cue to send.' : null) ??
    (run.busy ? 'A comparison is already running.' : null);

  const submit = useCallback(() => {
    if (runReason || !characterId) return;
    onRun(probe.trim(), chosen, characterId);
  }, [characterId, chosen, onRun, probe, runReason]);

  const applyProbe = useCallback((entry: ArenaProbe) => setProbe(entry.text), []);

  const rowFor = useCallback(
    (contenderId: string) =>
      rows.find((entry) => entry.contenderId === (canonical.get(contenderId) ?? contenderId)) ??
      null,
    [canonical, rows],
  );

  /** Corner colours for the masthead, resolved against the entrants actually in it. */
  const mastColours = useMemo(
    () => viewSeries(picks.filter(Boolean), preferredSlots),
    [picks, preferredSlots],
  );

  // Newest first: you have just run it, so it should be under your hand rather than at the
  // bottom of a growing page. The ghost numeral keeps the original order readable.
  const runs = useMemo(
    () => run.state.runs.map((entry, index) => ({ entry, number: index + 1 })).reverse(),
    [run.state.runs],
  );

  const visibleRuns = focusedRunId ? runs.filter((item) => item.entry.id === focusedRunId) : runs;

  return (
    <div className="arena-bench">
      {/* ------------------------------------------------------------ masthead */}
      <div className="arena-mast" data-columns={columns}>
        {picks.map((pick, index) => {
          const entry = resolved.find((item) => item.contender.id === pick);
          const row = pick ? rowFor(pick) : null;
          const colour = mastColours.get(pick);
          const side = index === 0 ? 'a' : index === 1 && columns === 2 ? 'b' : 'n';
          return (
            <div
              // The slot is the identity here — two slots can legitimately hold the same
              // value while the user is mid-change, so the value cannot be the key.
              // biome-ignore lint/suspicious/noArrayIndexKey: the column slot is the identity
              key={index}
              className="arena-corner"
              data-side={side}
              style={{ '--wc-corner': colour } as CSSProperties}
            >
              <div className="arena-corner__pick">
                <span className="arena-corner__swatch" aria-hidden="true" />
                <CornerPicker
                  resolved={resolved}
                  value={pick}
                  column={index + 1}
                  side={side}
                  onChange={(id) =>
                    setPicks((current) =>
                      current.map((current_, i) => (i === index ? id : current_)),
                    )
                  }
                />
              </div>

              <span className="arena-corner__meta">
                {entry?.connection?.name ?? entry?.unavailableReason ?? 'Nobody in this corner'}
              </span>

              {/* The record the app already knew, at the moment you are choosing. */}
              {row && row.rounds + row.rejected > 0 ? (
                <div className="arena-corner__record">
                  <span className="arena-corner__rating">
                    {row.rating}
                    {row.provisional ? (
                      <i
                        className="arena-corner__provisional"
                        title={`Provisional — fewer than the settled minimum. ${row.rounds} rated rounds so far.`}
                      >
                        ?
                      </i>
                    ) : null}
                  </span>
                  <span className="arena-corner__wl">
                    {row.wins}W · {row.losses}L · {row.ties}T
                  </span>
                </div>
              ) : (
                <div className="arena-corner__record">
                  <span className="arena-corner__unrated">No blind rounds yet</span>
                </div>
              )}
            </div>
          );
        })}

        {/*
         * The card, in the seam. Not a setting: it is the venue, and both contenders are
         * being judged on how well they play it — so the medallion itself is what you click
         * to change it, rather than a labelled field beside it.
         */}
        <CharacterPicker characters={characters} value={characterId} onChange={onSelectCharacter} />
      </div>

      {/* ------------------------------------------------------------ cue rail */}
      <div className="arena-cue">
        <div className="arena-cue__chips">
          <span className="arena-cue__label">Cues</span>
          {settings.probes.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="arena-chip"
              data-on={entry.text === probe}
              onClick={() => applyProbe(entry)}
              title={entry.text}
            >
              <span aria-hidden="true">▸</span>
              <span className="arena-chip__text">{entry.text || 'Empty cue'}</span>
            </button>
          ))}
          {settings.probes.length === 0 ? (
            <span className="arena-cue__none">
              None saved — write one below, or add some in Pool.
            </span>
          ) : null}

          <div className="arena-cue__settings">
            <label className="arena-cue__columns">
              Columns
              <select
                className="wc-select"
                value={columns}
                aria-label="How many contenders to compare at once"
                onChange={(event) => onSettingsChange({ columns: Number(event.target.value) })}
              >
                {[2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            {/*
             * Four columns on a 1240px canvas is about 38 characters a line, which is a
             * ticker tape whatever the type size. Saying so is more honest than quietly
             * shrinking the prose — and Wide is the answer for anyone with the monitor for it.
             */}
            {columns > 2 ? (
              <span className="arena-cue__warn" role="note">
                {columns === 4 ? 'Four-up is a scanning view, not a reading one.' : null}
              </span>
            ) : null}
          </div>
        </div>

        <div className="arena-cue__send">
          <CueField
            value={probe}
            onChange={setProbe}
            onSubmit={submit}
            ariaLabel="Cue to send to every column"
            placeholder="What the user says. Macros work: {{char}}, {{user}}."
          />
          <div className="arena-cue__actions">
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
                onClick={submit}
                disabled={Boolean(runReason)}
                title={runReason ?? 'Send this cue to every column'}
              >
                <SendIcon />
                Send to {chosen.length || columns} corners
              </button>
            )}
            <span className="arena-cue__hint">Enter sends · Shift+Enter for a new line</span>
          </div>
        </div>

        {run.error ? (
          <p className="arena-error" role="alert">
            {run.error}
          </p>
        ) : null}
      </div>

      {/* ------------------------------------------------------------ run log */}
      <div className="arena-log">
        {runs.length === 0 ? (
          <div className="arena-empty">
            <div className="arena-empty__ring" aria-hidden="true">
              <span className="arena-empty__corner" />
              <span className="arena-empty__seam" />
              <span className="arena-empty__corner" />
            </div>
            <p className="arena-empty__lede">Nothing has run yet.</p>
            <ol className="arena-empty__steps">
              <li>Pick the card they play.</li>
              <li>Fill both corners.</li>
              <li>Send a cue, and read them side by side.</li>
            </ol>
            <p className="arena-empty__note">
              Nothing here is scored. The leaderboard only counts blind rounds, because a comparison
              where you knew which one was which is not evidence.
            </p>
          </div>
        ) : null}

        {focusedRunId && visibleRuns.length === 0 ? (
          <p className="wc-empty">That comparison has been removed.</p>
        ) : null}

        {visibleRuns.map(({ entry, number }) => {
          const settled = isRunSettled(entry);
          const runCharacter = characters.find((item) => item.avatar === entry.characterId);
          const leaders = columnLeaders(entry.entries);
          const ratios = lengthRatios(entry.entries);
          const colours = viewSeries(
            entry.entries.map((column) => column.contenderId),
            preferredSlots,
          );
          const focused = focusedRunId === entry.id;
          return (
            <article key={entry.id} className="arena-run">
              <div className="arena-run__index" aria-hidden="true">
                <span className="arena-run__number">{String(number).padStart(2, '0')}</span>
              </div>

              <div className="arena-run__main">
                <header className="arena-run__head">
                  <img
                    className="arena-run__avatar"
                    src={characterApi.imageUrl(entry.characterId)}
                    alt=""
                  />
                  <div className="arena-run__scene">
                    <span className="arena-run__character">
                      {runCharacter?.name ?? entry.characterId}
                    </span>
                    <p className="arena-run__probe">{entry.probe}</p>
                  </div>
                  <div className="arena-run__actions">
                    <button
                      type="button"
                      className="wc-button wc-button--ghost"
                      onClick={() => setFocusedRunId(focused ? null : entry.id)}
                      title={
                        focused
                          ? 'Show the whole log again'
                          : 'Show this comparison on its own, at full width'
                      }
                      aria-pressed={focused}
                    >
                      {focused ? <ShrinkIcon /> : <ExpandIcon />}
                      {focused ? 'Back to the log' : 'Focus'}
                    </button>
                    <button
                      type="button"
                      className="wc-button wc-button--ghost"
                      // The run's OWN card, not whatever is staged now: a log can hold runs
                      // against several cards, and "again" beside a labelled comparison has to
                      // mean that comparison.
                      onClick={() =>
                        onRun(
                          entry.probe,
                          entry.entries.map((item) => item.contenderId),
                          entry.characterId,
                        )
                      }
                      disabled={run.busy || !settled}
                      title={
                        run.busy || !settled
                          ? 'A comparison is already running'
                          : 'Run this cue again, as a new comparison'
                      }
                    >
                      <RefreshIcon />
                      Again
                    </button>
                    <button
                      type="button"
                      className="wc-button wc-button--ghost"
                      onClick={() => {
                        if (focused) setFocusedRunId(null);
                        run.removeRun(entry.id);
                      }}
                      disabled={!settled}
                      title={settled ? 'Remove this comparison' : 'Still running'}
                      aria-label="Remove this comparison"
                    >
                      <CloseIcon />
                    </button>
                  </div>
                </header>

                <div
                  className="arena-run__columns"
                  style={{ '--wc-arena-columns': entry.entries.length } as CSSProperties}
                >
                  {entry.entries.map((column, index) => (
                    <ContenderColumn
                      key={column.contenderId}
                      entry={column}
                      stream={run.streams[index] ?? null}
                      display={displayFor(entry.characterId)}
                      colour={colours.get(column.contenderId)}
                      lengthRatio={ratios.get(column.contenderId) ?? 0}
                      leaders={leaders}
                      onReroll={() => void run.rerollColumn(entry.id, column.contenderId)}
                      rerollDisabledReason={
                        run.busy ? 'A comparison is already running' : !ready ? readyReason : null
                      }
                    />
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {/*
       * Width is a property of the reader's monitor, not of the comparison, so it lives with
       * the log rather than on a run. Two columns of prose at 1240px is a comfortable
       * measure; four is not, and someone on a 32" display should not be held to a canvas
       * sized for a laptop.
       */}
      {runs.length > 0 ? (
        <div className="arena-log__foot">
          <label className="arena-log__wide">
            <input
              type="checkbox"
              checked={wide}
              onChange={(event) => onWideChange(event.target.checked)}
            />
            <span>Use the full window width</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
