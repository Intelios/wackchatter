/**
 * Setting up what the Arena draws from: contenders, cards, cues, and the shared prompt.
 *
 * Two conventions do a lot of work here. Contenders and cues follow the persona rule — the
 * id is opaque and stable, the name is editable — because recorded rounds key on the id, and
 * a rename must never orphan a rating. And nothing is ever silently dropped: a contender
 * whose connection was deleted stays in the list, disabled, with the reason on its own row,
 * because the alternative is a pool that quietly shrinks when you tidy your connections and a
 * leaderboard whose labels change with it.
 *
 * Order is meaningful now. A contender's position assigns the corner colour it wears on every
 * other screen, so dragging the roster is a real edit rather than a cosmetic one — and it is
 * the one place that colour can be chosen, since nothing about it is stored.
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement } from '@dnd-kit/modifiers';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Connection, ProviderModel } from '@shared/providers/types.ts';
import type { ArenaProbe, ArenaRound, ArenaSettings, Contender } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GripIcon, PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { settingsApi } from '../../lib/api.ts';
import { ModelCombobox } from '../connection/ModelCombobox.tsx';
import { personaDisplayName } from '../persona/personaRoster.ts';
import { CardPicker } from './CardPicker.tsx';
import { CueField } from './CueField.tsx';
import type { ResolvedContender } from './contenders.ts';
import { contenderLabel } from './contenders.ts';
import { ExampleCuePicker } from './ExampleCuePicker.tsx';
import type { LeaderboardRow } from './elo.ts';
import { PROVISIONAL_ROUNDS } from './elo.ts';
import { MergePicker } from './MergePicker.tsx';
import { headToHead, unplayedPairings } from './matchups.ts';
import { canonicalId, drawable, type MergedView, type MergeMap } from './merges.ts';
import { colourOf } from './series.ts';

interface PoolPanelProps {
  settings: ArenaSettings;
  onSettingsChange: (patch: Partial<ArenaSettings>) => void;
  resolved: readonly ResolvedContender[];
  connections: readonly Connection[];
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  presets: readonly PresetSummary[];
  activePresetId: string | null;
  /** The preset a round will actually run with, for the cost strip. */
  preset: Preset | null;
  rounds: readonly ArenaRound[];
  rows: readonly LeaderboardRow[];
  /** The history as the boards read it, with merges folded — for the coverage strip. */
  merged: MergedView;
  colours: ReadonlyMap<string, string>;
  hiddenTags: readonly string[];
  onClearHistory: () => void;
  onPurgeContender?: (contenderId: string) => void;
}

interface EntrantProps {
  resolved: ResolvedContender;
  colour: string;
  row: LeaderboardRow | null;
  connections: readonly Connection[];
  models: ProviderModel[];
  /** The whole pool, for the merge picker's target list and its naming. */
  pool: readonly ResolvedContender[];
  merged: MergeMap;
  /** The contender this one's rounds are folded under, resolved, or null when standalone. */
  mergedInto: ResolvedContender | null;
  /** Contenders folded *into* this one, for the chip. Empty unless it is a merge root. */
  mergedFrom: readonly ResolvedContender[];
  onMerge: (targetId: string) => void;
  onUnmerge: () => void;
  onPatch: (patch: Partial<Contender>) => void;
  onRemove: () => void;
}

function Entrant({
  resolved,
  colour,
  row,
  connections,
  models,
  pool,
  merged,
  mergedInto,
  mergedFrom,
  onMerge,
  onUnmerge,
  onPatch,
  onRemove,
}: EntrantProps) {
  const { contender, unavailableReason } = resolved;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: contender.id,
  });

  return (
    <li
      ref={setNodeRef}
      className="arena-entrant"
      data-unavailable={unavailableReason !== null}
      data-dragging={isDragging}
      data-merged={mergedInto !== null}
      style={
        {
          '--wc-corner': colour,
          transform: CSS.Transform.toString(transform),
          transition,
        } as CSSProperties
      }
    >
      <div className="arena-entrant__top">
        <button
          type="button"
          className="arena-entrant__grip"
          aria-label={`Reorder ${contender.name || contender.model || 'contender'}`}
          title="Drag to reorder. Position sets the colour it wears everywhere else."
          {...attributes}
          {...listeners}
        >
          <GripIcon />
        </button>

        <input
          className="wc-input arena-entrant__name"
          value={contender.name}
          placeholder={contender.model || 'Name it (optional)'}
          aria-label="Contender name"
          onChange={(event) => onPatch({ name: event.target.value })}
        />

        <label
          className="arena-entrant__enabled"
          title={
            mergedInto
              ? `${contenderLabel(mergedInto.contender, mergedInto.connection)} fights for both in the blind draw.`
              : undefined
          }
        >
          <input
            type="checkbox"
            checked={contender.enabled}
            // A folded entry cannot be drawn: its rounds already count under the identity
            // that absorbed it, so drawing both would pay for a round the board discards.
            // The bench still offers it — that is where the two providers are compared.
            disabled={mergedInto !== null}
            onChange={(event) => onPatch({ enabled: event.target.checked })}
          />
          <span>In draw</span>
        </label>
      </div>

      <div className="arena-entrant__where">
        <select
          className="wc-select"
          value={contender.connectionId}
          aria-label="Connection"
          onChange={(event) =>
            // The model belongs to the endpoint it was chosen against, so moving the
            // contender drops it rather than pointing a stale id at a new server.
            onPatch({ connectionId: event.target.value, model: '' })
          }
        >
          <option value="">Choose a connection…</option>
          {connections.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>

        <ModelCombobox
          models={models}
          value={contender.model}
          onCommit={(model) => onPatch({ model })}
          disabled={!contender.connectionId}
          disabledReason="Choose a connection first"
        />
      </div>

      {unavailableReason ? (
        <p className="arena-entrant__warn">⚠ {unavailableReason} Its recorded rounds are kept.</p>
      ) : null}

      {mergedInto ? (
        <p className="arena-entrant__folded">
          Counted under{' '}
          <strong>{contenderLabel(mergedInto.contender, mergedInto.connection)}</strong> — one
          rating over both.{' '}
          <button type="button" className="arena-entrant__unmerge" onClick={onUnmerge}>
            Split apart
          </button>
        </p>
      ) : null}

      {mergedFrom.length > 0 ? (
        <p className="arena-entrant__foldin">
          Includes{' '}
          {mergedFrom.map((entry) => contenderLabel(entry.contender, entry.connection)).join(', ')}.
        </p>
      ) : null}

      <div className="arena-entrant__record">
        {row && row.rounds + row.rejected > 0 ? (
          <>
            <span className="arena-entrant__rating">{row.rating}</span>
            <span className="arena-entrant__wl">
              {row.wins}W · {row.losses}L · {row.ties}T
            </span>
            <span
              className="arena-entrant__rounds"
              data-provisional={row.provisional}
              title={
                row.provisional
                  ? `Fewer than ${PROVISIONAL_ROUNDS} rated rounds — still noise.`
                  : undefined
              }
            >
              {row.rounds} {row.rounds === 1 ? 'round' : 'rounds'}
              {row.provisional ? ' · provisional' : ''}
            </span>
          </>
        ) : (
          <span className="arena-entrant__unrated">No blind rounds yet</span>
        )}
      </div>

      <div className="arena-entrant__actions">
        {mergedInto ? null : (
          <MergePicker source={contender} resolved={pool} merged={merged} onMerge={onMerge} />
        )}
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger arena-entrant__remove"
          onClick={onRemove}
          title="Remove from the pool. Its recorded rounds are kept."
          aria-label={`Remove ${contender.name || 'contender'}`}
        >
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}

export function PoolPanel({
  settings,
  onSettingsChange,
  resolved,
  connections,
  characters,
  personas,
  presets,
  activePresetId,
  preset,
  rounds,
  rows,
  merged,
  colours,
  hiddenTags,
  onClearHistory,
  onPurgeContender,
}: PoolPanelProps) {
  const [models, setModels] = useState<Record<string, ProviderModel[]>>({});
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingCueId, setConfirmingCueId] = useState<string | null>(null);
  const [confirmingRetiredId, setConfirmingRetiredId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!confirmingClear) return;
    const timer = setTimeout(() => setConfirmingClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  useEffect(() => {
    if (!confirmingCueId) return;
    const timer = setTimeout(() => setConfirmingCueId(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmingCueId]);

  useEffect(() => {
    if (!confirmingRetiredId) return;
    const timer = setTimeout(() => setConfirmingRetiredId(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmingRetiredId]);

  /*
   * Model catalogues, fetched once per connection that a contender actually points at.
   *
   * Lazily and per connection rather than for all of them up front: a pool of six
   * contenders on one endpoint should cost one request, and an endpoint nobody is using
   * should cost none.
   */
  const wanted = [...new Set(settings.contenders.map((entry) => entry.connectionId))].filter(
    (id) => id && connections.some((connection) => connection.id === id),
  );
  const wantedKey = wanted.join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: wantedKey stands in for wanted
  useEffect(() => {
    let cancelled = false;
    for (const id of wanted) {
      if (models[id]) continue;
      void settingsApi
        .models(id)
        .then((result) => {
          if (!cancelled) setModels((current) => ({ ...current, [id]: result.models }));
        })
        .catch(() => {
          // An endpoint that will not list its models is not an error worth a banner: the
          // combobox accepts a typed model id, which is the whole reason it is a combobox.
          if (!cancelled) setModels((current) => ({ ...current, [id]: [] }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [wantedKey, models]);

  const patchContender = useCallback(
    (id: string, patch: Partial<Contender>) => {
      onSettingsChange({
        contenders: settings.contenders.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      });
    },
    [onSettingsChange, settings.contenders],
  );

  const addContender = useCallback(() => {
    const connection = connections[0];
    onSettingsChange({
      contenders: [
        ...settings.contenders,
        {
          id: crypto.randomUUID(),
          name: '',
          connectionId: connection?.id ?? '',
          // Empty follows the connection's own model, which is the right default: it makes
          // "benchmark what I normally use" a one-click entry.
          model: '',
          enabled: true,
        },
      ],
    });
  }, [connections, onSettingsChange, settings.contenders]);

  const removeContender = useCallback(
    (id: string) => {
      // Rounds are NOT touched. A contender's history outlives it — see `replayRatings`.
      onSettingsChange({
        contenders: settings.contenders.filter((entry) => entry.id !== id),
      });
    },
    [onSettingsChange, settings.contenders],
  );

  /**
   * Fold one contender's rounds under another.
   *
   * Written as an id → id map rather than a field on the entry, so the fold outlives removing
   * the merged entry from the pool — which is the natural thing to do once it is merged, and
   * would otherwise silently split the history back in two. See `ArenaSettings`.
   */
  const mergeInto = useCallback(
    (sourceId: string, targetId: string) => {
      onSettingsChange({
        mergedContenders: { ...settings.mergedContenders, [sourceId]: targetId },
      });
    },
    [onSettingsChange, settings.mergedContenders],
  );

  /** Split a contender back out. Exact and free: no round was ever rewritten. */
  const unmerge = useCallback(
    (sourceId: string) => {
      const next: Record<string, string> = {};
      for (const [from, to] of Object.entries(settings.mergedContenders)) {
        if (from === sourceId) continue;
        next[from] = to;
      }
      onSettingsChange({ mergedContenders: next });
    },
    [onSettingsChange, settings.mergedContenders],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = settings.contenders.map((entry) => entry.id);
      const from = ids.indexOf(String(active.id));
      const to = ids.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      const next = [...settings.contenders];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      onSettingsChange({ contenders: next });
    },
    [onSettingsChange, settings.contenders],
  );

  const patchProbe = useCallback(
    (id: string, text: string) => {
      onSettingsChange({
        probes: settings.probes.map((entry) => (entry.id === id ? { ...entry, text } : entry)),
      });
    },
    [onSettingsChange, settings.probes],
  );

  const addProbe = useCallback(
    (text = '') => {
      const probe: ArenaProbe = { id: crypto.randomUUID(), text };
      onSettingsChange({ probes: [...settings.probes, probe] });
    },
    [onSettingsChange, settings.probes],
  );

  const toggleCard = useCallback(
    (avatar: string) => {
      /*
       * The first pick out of "every card" means that one card, not every card but this one.
       *
       * An empty pool is the whole library, so toggling a card while empty previously
       * produced a pool of one — correct — but toggling one while showing every card as
       * checked read as "uncheck this one". Starting the explicit pool at exactly the card
       * you clicked is the only reading that matches the click.
       */
      const pool = settings.cardPool.includes(avatar)
        ? settings.cardPool.filter((entry) => entry !== avatar)
        : [...settings.cardPool, avatar];
      onSettingsChange({ cardPool: pool });
    },
    [onSettingsChange, settings.cardPool],
  );

  const everyCard = settings.cardPool.length === 0;

  /**
   * The record shown on a contender's row.
   *
   * Resolved through the merge map, so a folded entry reports the merged model's record
   * rather than "no blind rounds yet". Its own rounds are still its own — they are just
   * counted under the identity that absorbed them, and showing a separate number here would
   * be the second, disagreeing copy the no-ratings-table rule exists to prevent.
   */
  const rowFor = useCallback(
    (id: string) =>
      rows.find((entry) => entry.contenderId === canonicalId(merged.canonical, id)) ?? null,
    [merged.canonical, rows],
  );

  const retiredRows = useMemo(() => {
    const activeIds = new Set(settings.contenders.map((c) => c.id));
    // Rows are keyed by the merged identity, so a contender folded into another has no row
    // of its own — and must not be reported as retired for having "lost" one. Membership is
    // judged by the id it actually appears under.
    return rows.filter(
      (r) =>
        !activeIds.has(canonicalId(merged.canonical, r.contenderId)) && r.rounds + r.rejected > 0,
    );
  }, [merged.canonical, rows, settings.contenders]);

  const playCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const round of rounds) {
      counts.set(round.characterId, (counts.get(round.characterId) ?? 0) + 1);
    }
    return counts;
  }, [rounds]);

  const probeUses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const round of rounds) {
      counts.set(round.probe, (counts.get(round.probe) ?? 0) + 1);
    }
    return counts;
  }, [rounds]);

  /*
   * What a sitting is going to cost, before you commit to forty rounds of it.
   *
   * Two generations a round, the reply cap both sides share, and how many pairings have
   * never met — the number that actually answers "how much longer until this means
   * something", since least-played pairing brings it down steadily rather than at random.
   *
   * Counted over the *merged* identities, because that is what the draw does: a folded
   * contender does not get pulled, so including it here would promise coverage the draw
   * will never deliver.
   */
  const eligibleIds = useMemo(
    () =>
      resolved
        .filter(
          (entry) =>
            entry.contender.enabled &&
            entry.connection !== null &&
            drawable(merged.canonical, entry.contender.id),
        )
        .map((entry) => entry.contender.id),
    [merged.canonical, resolved],
  );
  const unplayed = useMemo(
    () => unplayedPairings(headToHead(merged.rounds), eligibleIds),
    [eligibleIds, merged.rounds],
  );
  const stillProvisional = rows.filter(
    (row) => row.provisional && eligibleIds.includes(row.contenderId),
  ).length;

  return (
    <div className="arena-pool">
      {/* ---------------------------------------------------------- contenders */}
      <section className="arena-pool__section">
        <header className="arena-pool__head">
          <div>
            <h2>Contenders</h2>
            <p className="wc-hint">
              An endpoint plus a model. One connection can hold as many contenders as you like —
              leave the model blank to use the connection&rsquo;s own. Drag to reorder: position
              sets the colour each one wears across the Arena.
            </p>
          </div>
          <button type="button" className="wc-button" onClick={addContender}>
            <PlusIcon />
            Add contender
          </button>
        </header>

        {resolved.length === 0 ? (
          <p className="wc-empty">No contenders yet. Add two to start comparing.</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={resolved.map((entry) => entry.contender.id)}
              strategy={rectSortingStrategy}
            >
              <ul className="arena-roster">
                {resolved.map((entry) => {
                  const root = canonicalId(merged.canonical, entry.contender.id);
                  const targetId = settings.mergedContenders[entry.contender.id];
                  const mergedInto =
                    resolved.find((item) => item.contender.id === targetId) ?? null;
                  // Only the identity that absorbed the others lists them. A folded row
                  // reports where it went instead ("Counted under …"), and naming its root's
                  // members on both rows would read as two models each containing the other.
                  const mergedFrom =
                    mergedInto === null
                      ? resolved.filter(
                          (item) =>
                            item.contender.id !== entry.contender.id &&
                            canonicalId(merged.canonical, item.contender.id) === root,
                        )
                      : [];
                  return (
                    <Entrant
                      key={entry.contender.id}
                      resolved={entry}
                      colour={colourOf(colours, entry.contender.id)}
                      row={rowFor(entry.contender.id)}
                      connections={connections}
                      models={models[entry.contender.connectionId] ?? []}
                      pool={resolved}
                      merged={settings.mergedContenders}
                      mergedInto={mergedInto}
                      mergedFrom={mergedFrom}
                      onMerge={(targetId) => mergeInto(entry.contender.id, targetId)}
                      onUnmerge={() => unmerge(entry.contender.id)}
                      onPatch={(patch) => patchContender(entry.contender.id, patch)}
                      onRemove={() => removeContender(entry.contender.id)}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>

      {/* ------------------------------------------- retired contenders */}
      {retiredRows.length > 0 ? (
        <section className="arena-pool__section">
          <header className="arena-pool__head">
            <div>
              <h2>Retired from pool</h2>
              <p className="wc-hint">
                These models were removed from the pool but keep their recorded rounds in the
                leaderboard. You can add them back, or permanently delete them to purge their
                rounds.
              </p>
            </div>
          </header>
          <ul className="arena-retired">
            {retiredRows.map((retired) => {
              const label = retired.model || retired.contenderId;
              const isConfirming = confirmingRetiredId === retired.contenderId;
              return (
                <li key={retired.contenderId} className="arena-retired__row">
                  <div className="arena-retired__info">
                    <span className="arena-retired__name">{label}</span>
                    <span className="arena-retired__stats">
                      {retired.rating} rating · {retired.rounds}{' '}
                      {retired.rounds === 1 ? 'round' : 'rounds'} ({retired.wins}W ·{' '}
                      {retired.losses}L · {retired.ties}T)
                    </span>
                  </div>
                  <div className="arena-retired__actions">
                    <button
                      type="button"
                      className="wc-button wc-button--ghost"
                      onClick={() =>
                        onSettingsChange({
                          contenders: [
                            ...settings.contenders,
                            {
                              id: retired.contenderId,
                              name: label,
                              connectionId: '',
                              model: retired.model,
                              enabled: true,
                            },
                          ],
                        })
                      }
                      title="Add back to the active pool"
                    >
                      <PlusIcon />
                      Add to pool
                    </button>
                    {onPurgeContender ? (
                      <button
                        type="button"
                        className="wc-button wc-button--ghost wc-button--danger"
                        data-confirming={isConfirming || undefined}
                        onClick={() => {
                          if (isConfirming) {
                            onPurgeContender(retired.contenderId);
                            setConfirmingRetiredId(null);
                          } else {
                            setConfirmingRetiredId(retired.contenderId);
                          }
                        }}
                        onBlur={() =>
                          setConfirmingRetiredId((id) => (id === retired.contenderId ? null : id))
                        }
                        title={
                          isConfirming
                            ? 'Click again to permanently erase all rounds'
                            : 'Permanently delete model and rounds'
                        }
                        aria-label={isConfirming ? `Confirm delete ${label}` : `Delete ${label}`}
                      >
                        <TrashIcon />
                        {isConfirming ? 'Click again' : 'Permanently delete'}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- cues */}
      <section className="arena-pool__section">
        <header className="arena-pool__head">
          <div>
            <h2>Cues</h2>
            <p className="wc-hint">
              What the user says. A blind round draws one at random, so write the kinds of turn you
              actually send. Macros work: <code>{'{{char}}'}</code>, <code>{'{{user}}'}</code>.
            </p>
          </div>
          <div className="arena-pool__head-actions">
            <ExampleCuePicker
              existing={new Set(settings.probes.map((entry) => entry.text))}
              onAdd={(text) => addProbe(text)}
            />
            <button type="button" className="wc-button" onClick={() => addProbe()}>
              <PlusIcon />
              Add cue
            </button>
          </div>
        </header>

        {settings.probes.length === 0 ? (
          <p className="wc-empty">
            No cues yet — a blind round has nothing to ask. Write your own, or take a few to start
            from in Example cues.
          </p>
        ) : null}

        {settings.probes.length > 0 ? (
          <ul className="arena-cues">
            {settings.probes.map((probe, index) => {
              const uses = probeUses.get(probe.text) ?? 0;
              const isConfirming = confirmingCueId === probe.id;
              return (
                <li key={probe.id} className="arena-cuecard">
                  <CueField
                    value={probe.text}
                    onChange={(text) => patchProbe(probe.id, text)}
                    onSubmit={() => undefined}
                    rows={3}
                    ariaLabel={`Cue ${index + 1}`}
                    placeholder="What the user says…"
                  />
                  <footer className="arena-cuecard__foot">
                    <span>
                      {uses > 0 ? `Drawn ${uses}×` : 'Not yet drawn'}
                      {probe.text.includes('{{') ? ' · has macros' : ''}
                    </span>
                    <button
                      type="button"
                      className="wc-button wc-button--ghost wc-button--danger"
                      data-confirming={isConfirming || undefined}
                      onClick={() => {
                        if (isConfirming) {
                          onSettingsChange({
                            probes: settings.probes.filter((entry) => entry.id !== probe.id),
                          });
                          setConfirmingCueId(null);
                        } else {
                          setConfirmingCueId(probe.id);
                        }
                      }}
                      onBlur={() => setConfirmingCueId((id) => (id === probe.id ? null : id))}
                      title={isConfirming ? 'Click again to delete' : 'Delete cue'}
                      aria-label={
                        isConfirming ? `Confirm remove cue ${index + 1}` : `Remove cue ${index + 1}`
                      }
                    >
                      {isConfirming ? 'Sure?' : <TrashIcon />}
                    </button>
                  </footer>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {/* --------------------------------------------------------------- cards */}
      <section className="arena-pool__section">
        <header className="arena-pool__head">
          <div>
            <h2>Cards</h2>
            <p className="wc-hint">
              {everyCard
                ? 'Blind rounds draw from your whole library.'
                : `Blind rounds draw from these ${settings.cardPool.length}.`}
            </p>
          </div>
        </header>

        <CardPicker
          characters={characters}
          selected={settings.cardPool}
          everyCard={everyCard}
          onToggle={toggleCard}
          onUseEvery={() => onSettingsChange({ cardPool: [] })}
          hiddenTags={hiddenTags}
          playCounts={playCounts}
        />
      </section>

      {/* --------------------------------------------------------- round setup */}
      <section className="arena-pool__section">
        <h2>Round setup</h2>
        <p className="wc-hint">
          Both sides of a round always share these, which is what makes the comparison about the
          model rather than the setup.
        </p>

        <div className="arena-pool__row">
          <label className="wc-label" htmlFor="arena-preset">
            Preset
          </label>
          <select
            id="arena-preset"
            className="wc-select"
            value={settings.presetId ?? ''}
            onChange={(event) => onSettingsChange({ presetId: event.target.value || null })}
          >
            <option value="">
              Active preset
              {activePresetId
                ? ` (${presets.find((entry) => entry.id === activePresetId)?.name ?? activePresetId})`
                : ''}
            </option>
            {presets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>

        <div className="arena-pool__row">
          <label className="wc-label" htmlFor="arena-persona">
            Persona
          </label>
          <select
            id="arena-persona"
            className="wc-select"
            value={settings.personaId ?? ''}
            onChange={(event) => onSettingsChange({ personaId: event.target.value || null })}
          >
            <option value="">No persona</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {/* The label in brackets — a <select> cannot show a chip, and two options
                    both reading "John Doe" would be a menu that cannot be ordered from. */}
                {personaDisplayName(persona)}
              </option>
            ))}
          </select>
        </div>
        <p className="wc-hint">
          Pinned here rather than following the app&rsquo;s current persona: a benchmark whose
          prompts change when you switch persona elsewhere is not measuring models.
        </p>

        <label className="arena-pool__check">
          <input
            type="checkbox"
            checked={settings.holdBlindUntilComplete}
            onChange={(event) => onSettingsChange({ holdBlindUntilComplete: event.target.checked })}
          />
          <span>Hold blind replies until both finish</span>
        </label>
        <p className="wc-hint">
          On by default. Token rate gives a model away as surely as its name — a local model and a
          hosted one are told apart by cadence alone.
        </p>

        <div className="arena-cost">
          <dl className="arena-tape">
            <div className="arena-tape__cell">
              <dd className="arena-tape__value">2</dd>
              <dt className="arena-tape__key">Generations / round</dt>
            </div>
            <div className="arena-tape__cell">
              <dd className="arena-tape__value">
                {preset?.openai_max_tokens ? preset.openai_max_tokens : '—'}
              </dd>
              <dt className="arena-tape__key">Reply cap, each</dt>
            </div>
            <div className="arena-tape__cell">
              <dd className="arena-tape__value">{eligibleIds.length}</dd>
              <dt className="arena-tape__key">In the draw</dt>
            </div>
            <div className="arena-tape__cell">
              <dd className="arena-tape__value">{unplayed}</dd>
              <dt className="arena-tape__key">Unplayed pairings</dt>
            </div>
          </dl>
          <p className="arena-cost__note">
            {stillProvisional > 0
              ? `${stillProvisional} rating${stillProvisional === 1 ? '' : 's'} still provisional — ${PROVISIONAL_ROUNDS} rated rounds each settles them.`
              : eligibleIds.length < 2
                ? 'Enable at least two contenders to draw a round.'
                : 'Every enabled contender has a settled rating.'}
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------- history */}
      <section className="arena-pool__section">
        <h2>History</h2>
        <p className="wc-hint">
          {rounds.length === 0
            ? 'No blind rounds recorded yet.'
            : `${rounds.length} blind ${rounds.length === 1 ? 'round' : 'rounds'} recorded. The leaderboard is replayed from them, so clearing this resets every rating.`}
        </p>
        {merged.collapsed > 0 ? (
          <p className="wc-hint">
            {merged.collapsed} of them ran two providers of one merged model against each other. The
            round is still recorded, but the leaderboard leaves it out — a model cannot be compared
            with itself, and scoring it either way would move a rating on evidence that contains no
            comparison.
          </p>
        ) : null}
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger"
          data-confirming={confirmingClear}
          disabled={rounds.length === 0}
          onClick={() => {
            if (!confirmingClear) {
              setConfirmingClear(true);
              return;
            }
            setConfirmingClear(false);
            onClearHistory();
          }}
          onBlur={() => setConfirmingClear(false)}
        >
          <TrashIcon />
          {confirmingClear ? 'Click again to erase every round' : 'Clear benchmark history'}
        </button>
      </section>
    </div>
  );
}
