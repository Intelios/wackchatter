/**
 * The open Arena: a test bench.
 *
 * You choose the card, you choose who runs, you write the probe, and every reply is
 * labelled. Nothing here is scored — a comparison where you knew which one was which is
 * not evidence about which is better, and the leaderboard only ever hears from blind
 * rounds.
 *
 * Runs stack, newest first. Each one is independent: the same scene, a different probe,
 * and no reply ever feeds into the next. That is the whole difference between this and a
 * chat, and it is why run five is as comparable as run one.
 */

import type { ArenaProbe, ArenaSettings } from '@shared/types/arena.ts';
import { ARENA_MAX_COLUMNS, ARENA_MIN_COLUMNS } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloseIcon, RefreshIcon, SendIcon, StopIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { ContenderColumn } from './ContenderColumn.tsx';
import type { ResolvedContender } from './contenders.ts';
import { contenderLabel } from './contenders.ts';
import type { ArenaDisplay } from './display.ts';
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
}: ArenaBenchProps) {
  const [probe, setProbe] = useState('');
  const [picks, setPicks] = useState<string[]>([]);

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
    (!probe.trim() ? 'Write a probe to send.' : null) ??
    (run.busy ? 'A comparison is already running.' : null);

  const submit = useCallback(() => {
    if (runReason || !characterId) return;
    onRun(probe.trim(), chosen, characterId);
  }, [characterId, chosen, onRun, probe, runReason]);

  const applyProbe = useCallback((entry: ArenaProbe) => setProbe(entry.text), []);

  // Newest first: you have just run it, so it should be under your hand rather than at the
  // bottom of a growing page.
  const runs = useMemo(() => [...run.state.runs].reverse(), [run.state.runs]);

  return (
    <div className="arena-bench">
      <div className="arena-setup">
        <div className="arena-setup__row">
          <label className="wc-label" htmlFor="arena-card">
            Character
          </label>
          <select
            id="arena-card"
            className="wc-select"
            value={characterId ?? ''}
            onChange={(event) => onSelectCharacter(event.target.value)}
          >
            <option value="">Choose a character…</option>
            {characters.map((character) => (
              <option key={character.avatar} value={character.avatar}>
                {character.name}
              </option>
            ))}
          </select>

          <label className="wc-label" htmlFor="arena-columns">
            Columns
          </label>
          <select
            id="arena-columns"
            className="wc-select arena-setup__columns"
            value={columns}
            onChange={(event) => onSettingsChange({ columns: Number(event.target.value) })}
          >
            {[2, 3, 4].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </div>

        <div className="arena-setup__picks" style={{ '--wc-arena-columns': columns } as never}>
          {picks.map((pick, index) => (
            <select
              // The slot is the identity here — two slots can legitimately hold the same
              // value while the user is mid-change, so the value cannot be the key.
              // biome-ignore lint/suspicious/noArrayIndexKey: the column slot is the identity
              key={index}
              className="wc-select"
              value={pick}
              aria-label={`Contender for column ${index + 1}`}
              onChange={(event) => {
                const value = event.target.value;
                setPicks((current) => current.map((entry, i) => (i === index ? value : entry)));
              }}
            >
              <option value="">—</option>
              {resolved.map((entry) => (
                <option
                  key={entry.contender.id}
                  value={entry.contender.id}
                  disabled={entry.connection === null}
                  title={entry.unavailableReason ?? undefined}
                >
                  {contenderLabel(entry.contender, entry.connection)}
                  {entry.connection === null ? ' (unavailable)' : ''}
                </option>
              ))}
            </select>
          ))}
        </div>

        {settings.probes.length > 0 ? (
          <div className="arena-setup__probes">
            {settings.probes.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="wc-button wc-button--ghost arena-probe-chip"
                onClick={() => applyProbe(entry)}
                title={entry.text}
              >
                {entry.text.slice(0, 40) || 'Empty probe'}
              </button>
            ))}
          </div>
        ) : null}

        <div className="arena-setup__send">
          <textarea
            className="wc-textarea arena-setup__probe"
            value={probe}
            placeholder="What the user says. Macros work: {{char}}, {{user}}."
            rows={3}
            onChange={(event) => setProbe(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the composer's bargain, because
              // a probe is one or two lines and reaching for a button every time is friction
              // in the loop this screen exists to make fast.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
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
              title={runReason ?? 'Send this probe to every column'}
            >
              <SendIcon />
              Compare
            </button>
          )}
        </div>

        {run.error ? (
          <p className="arena-error" role="alert">
            {run.error}
          </p>
        ) : null}
      </div>

      <div className="arena-log">
        {runs.length === 0 ? (
          <p className="wc-empty">
            Pick a character and two contenders, write a probe, and compare. Nothing here is scored
            — the leaderboard only counts blind rounds.
          </p>
        ) : null}

        {runs.map((entry) => {
          const settled = isRunSettled(entry);
          const character = characters.find((item) => item.avatar === entry.characterId);
          return (
            <article key={entry.id} className="arena-run">
              <header className="arena-run__head">
                <img
                  className="arena-run__avatar"
                  src={characterApi.imageUrl(entry.characterId)}
                  alt=""
                />
                <div className="arena-run__scene">
                  <span className="arena-run__character">
                    {character?.name ?? entry.characterId}
                  </span>
                  <p className="arena-run__probe">{entry.probe}</p>
                </div>
                <div className="arena-run__actions">
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
                        : 'Run this probe again, as a new comparison'
                    }
                  >
                    <RefreshIcon />
                    Again
                  </button>
                  <button
                    type="button"
                    className="wc-button wc-button--ghost"
                    onClick={() => run.removeRun(entry.id)}
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
                style={{ '--wc-arena-columns': entry.entries.length } as never}
              >
                {entry.entries.map((column, index) => (
                  <ContenderColumn
                    key={column.contenderId}
                    entry={column}
                    stream={run.streams[index] ?? null}
                    display={displayFor(entry.characterId)}
                    onReroll={() => void run.rerollColumn(entry.id, column.contenderId)}
                    rerollDisabledReason={
                      run.busy ? 'A comparison is already running' : !ready ? readyReason : null
                    }
                  />
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
