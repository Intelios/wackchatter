/**
 * The Model Arena in the 3.0 shell.
 *
 * The leaderboard is the front door: opening the Arena shows the standings and what this
 * sitting did to them, with one button into the Benchmark. The Benchmark is one room for
 * both ways of comparing — blind (scored) and labelled (not scored) — and the pool of models
 * lives on the island, picked the way models are picked everywhere else. Lime is the
 * Arena's colour.
 *
 * Everything it knows and does is `useArena`, shared with the 2.x screen.
 */

import './studio.css';
import './arena.css';

import type { ModelRef } from '@shared/models/slots.ts';
import type { Contender } from '@shared/types/arena.ts';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppController } from '../app/useAppController.ts';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { replay } from '../features/arena/elo.ts';
import { canonicalId } from '../features/arena/merges.ts';
import { fallbackSlot, seriesToken } from '../features/arena/series.ts';
import { useArena } from '../features/arena/useArena.ts';
import { resolveDialogueColor, useAvatarColor } from '../features/chat/avatarColor.ts';
import { ModelsProvider } from '../features/models/ModelsContext.tsx';
import { modelCatalogueEntry } from '../features/models/modelContext.ts';
import { personaApi } from '../lib/api.ts';
import { ArenaBoard } from './ArenaBoard.tsx';
import { ArenaPool } from './ArenaPool.tsx';
import { ArenaRoom } from './ArenaRoom.tsx';
import { ArenaTournaments } from './ArenaTournaments.tsx';
import { latestSitting, type Price, type PriceOf, pricedModels, roundsCost } from './arenaStats.ts';
import { Island, type IslandMode, type IslandNotice } from './Island.tsx';
import { Icon } from './icons.tsx';
import { ModelPane } from './ModelPane.tsx';
import { modelLabel } from './PresetSession.tsx';
import { formatUsd } from './presetcc.ts';
import { initialAuraStyle, useAura } from './useAura.ts';

const LIME = '#c2ee4a';

export type ArenaScreen = 'board' | 'bench' | 'tour';

const SCREENS: [ArenaScreen, string][] = [
  ['board', 'Leaderboard'],
  ['bench', 'Benchmark'],
  ['tour', 'Tournaments'],
];

const priceKey = (connectionId: string, model: string) => `${connectionId}\u0000${model}`;

/** What a contender is called on screen: its own name, else the model's short name. */
export function contenderName(contender: Contender): string {
  if (contender.name.trim()) return contender.name.trim();
  return modelLabel(contender.model?.modelId) ?? 'Unnamed model';
}

export function Arena({ controller }: { controller: AppController }) {
  const { app, library } = controller;
  const { settings, view: prefs, models, patchSettings } = app;
  const connections = settings?.connections ?? [];

  const arenaSettings = prefs.arena;
  const latest = useRef(arenaSettings);
  latest.current = arenaSettings;
  // A patch, or a change worked out from the latest settings: two quick clicks must not
  // each start from the copy their render drew.
  const onSettingsChange = useCallback(
    (
      patch:
        | Partial<typeof arenaSettings>
        | ((current: typeof arenaSettings) => Partial<typeof arenaSettings>),
    ) => {
      const change = typeof patch === 'function' ? patch(latest.current) : patch;
      const next = { ...latest.current, ...change };
      latest.current = next;
      void patchSettings({ arena: next });
    },
    [patchSettings],
  );

  const arena = useArena({
    settings: arenaSettings,
    onSettingsChange,
    connections,
    presets: library.presets,
    activePresetId: library.presetId,
    activePreset: library.preset,
    characters: library.characters,
    personas: library.personas,
    books: library.books,
    globalLorebookIds: prefs.globalBookIds,
    worldInfoSettings: prefs.worldInfo,
    globalVariables: settings?.variables ?? {},
    regexScripts: prefs.regexScripts,
    tokenizerEncoding: settings?.tokenizerEncoding,
    streamingFps: prefs.streamingFps,
  });

  const [screen, setScreen] = useState<ArenaScreen>('board');
  const [blind, setBlind] = useState(true);
  const [mode, setMode] = useState<IslandMode | null>(null);
  const [notice, setNotice] = useState<IslandNotice | null>(null);

  // The shared engine stages lore for whichever room is in front.
  const { setMode: setArenaMode } = arena;
  useEffect(() => {
    setArenaMode(
      screen === 'board' ? 'board' : screen === 'tour' ? 'tournament' : blind ? 'blind' : 'bench',
    );
  }, [screen, blind, setArenaMode]);

  // --- Prices, for what rounds cost ---
  const pairs = useMemo(() => {
    const list = pricedModels(arena.rounds);
    for (const run of [arena.blindRun, arena.benchRun, arena.tournamentRun]) {
      for (const entry of run.state.runs.at(-1)?.entries ?? []) {
        list.push({ connectionId: entry.connectionId, model: entry.model });
      }
    }
    return list;
  }, [arena.rounds, arena.blindRun, arena.benchRun, arena.tournamentRun]);
  const [prices, setPrices] = useState<Record<string, Price | null>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const pair of pairs) {
      const key = priceKey(pair.connectionId, pair.model);
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      const connection = connections.find((c) => c.id === pair.connectionId);
      if (!connection) {
        setPrices((current) => ({ ...current, [key]: null }));
        continue;
      }
      void modelCatalogueEntry({
        id: connection.id,
        provider: connection.provider,
        baseUrl: connection.baseUrl,
        model: pair.model,
      }).then((found) => {
        const price =
          found &&
          typeof found.promptPrice === 'number' &&
          typeof found.completionPrice === 'number'
            ? { prompt: found.promptPrice, completion: found.completionPrice }
            : null;
        setPrices((current) => ({ ...current, [key]: price }));
      });
    }
  }, [pairs, connections]);
  const priceOf = useCallback<PriceOf>(
    (connectionId, model) => prices[priceKey(connectionId, model)] ?? null,
    [prices],
  );

  // --- Names ---
  const { merged } = arena;
  const poolById = useMemo(
    () => new Map(arenaSettings.contenders.map((c) => [c.id, c])),
    [arenaSettings.contenders],
  );
  const recorded = useMemo(() => {
    const map = new Map<string, string>();
    for (const round of arena.rounds) {
      map.set(round.left.contenderId, round.left.model);
      map.set(round.right.contenderId, round.right.model);
    }
    return map;
  }, [arena.rounds]);
  // Two pool entries with one name (the same model on two connections) say which is which.
  const sameNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of arenaSettings.contenders) {
      const name = contenderName(c);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [arenaSettings.contenders]);
  const nameOf = useCallback(
    (id: string) => {
      const contender = poolById.get(id);
      if (contender) {
        const name = contenderName(contender);
        if ((sameNames.get(name) ?? 0) < 2) return name;
        const via = connections.find((c) => c.id === contender.model?.connectionId)?.name;
        const twins = arenaSettings.contenders.filter((c) => contenderName(c) === name);
        const sameVia = twins.filter(
          (c) => c.model?.connectionId === contender.model?.connectionId,
        );
        return via && sameVia.length < 2
          ? `${name} · ${via}`
          : `${name} · ${twins.indexOf(contender) + 1}`;
      }
      return modelLabel(recorded.get(id)) ?? 'Removed model';
    },
    [poolById, recorded, sameNames, connections, arenaSettings.contenders],
  );
  const colourOf = useCallback(
    (id: string) => {
      const root = canonicalId(merged.canonical, id);
      return seriesToken(arena.preferredSlots.get(root) ?? fallbackSlot(root));
    },
    [arena.preferredSlots, merged.canonical],
  );

  const sitting = useMemo(
    () => latestSitting(merged.rounds, merged.contenders, Date.now()),
    [merged],
  );
  const sittingCost = useMemo(
    () => (sitting ? roundsCost(sitting.rounds, priceOf) : null),
    [sitting, priceOf],
  );

  // --- The pool ---
  const addModel = (ref: ModelRef | null) => {
    if (!ref) return;
    const same = arenaSettings.contenders.find(
      (c) => c.model?.connectionId === ref.connectionId && c.model.modelId === ref.modelId,
    );
    if (same) {
      if (!same.enabled) {
        onSettingsChange({
          contenders: arenaSettings.contenders.map((c) =>
            c.id === same.id ? { ...c, enabled: true } : c,
          ),
        });
      }
    } else {
      onSettingsChange({
        contenders: [
          ...arenaSettings.contenders,
          { id: crypto.randomUUID(), name: '', model: ref, enabled: true },
        ],
      });
    }
    setMode('pool');
  };

  // --- Colour ---
  const rootRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const persona = library.personas.find((p) => p.id === settings?.personaId) ?? null;
  const personaUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, library.personaAvatarVersions[persona.id] ?? persona.avatar)
    : null;
  const personaOverride = persona ? prefs.dialogueColors.personas[persona.id] : undefined;
  const personaAuto = useAvatarColor(personaOverride == null ? personaUrl : null);
  const personaColor = resolveDialogueColor(true, personaOverride, personaAuto).color;
  useAura(rootRef, washRef, LIME, personaColor, 'arena');
  const [firstAura] = useState(() => initialAuraStyle(LIME, personaColor));

  const busy = arena.benchRun.busy || arena.blindRun.busy || arena.tournamentRun.busy;
  const enabled = arenaSettings.contenders.filter((c) => c.enabled).length;
  const islandMode: IslandMode = mode ?? 'rest';
  const backLabel = controller.active ? 'Back to chat' : 'Home';

  const restPane = (
    <>
      <span className="w3-st-mark">
        <Icon name="arena" size="sm" />
        Arena
      </span>
      {arena.sessionVerdicts.length ? (
        <span className="w3-ar-streak" title="This visit, one mark per round">
          {arena.sessionVerdicts.slice(-24).map((verdict, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the strip is positional
            <i key={index} data-v={verdict} />
          ))}
        </span>
      ) : null}
      {sitting ? (
        <>
          <span className="w3-isl-sep" aria-hidden="true" />
          <span
            className="w3-ar-isl-sit"
            title={
              sittingCost?.priced
                ? sittingCost.complete
                  ? 'This sitting, at the providers’ listed prices'
                  : 'This sitting. Some replies have no recorded usage or price and are left out.'
                : 'This sitting'
            }
          >
            <b>
              {sitting.rounds.length} {sitting.rounds.length === 1 ? 'round' : 'rounds'}
              {sittingCost?.priced
                ? ` · ${formatUsd(sittingCost.usd)}${sittingCost.complete ? '' : '+'}`
                : ''}
            </b>
            <small>This sitting</small>
          </span>
        </>
      ) : null}
      <span className="w3-isl-sep" aria-hidden="true" />
      <button
        type="button"
        className="w3-isl-btn w3-ar-isl-pool"
        title="The models the Arena draws from"
        onClick={() => setMode('pool')}
      >
        <span className="w3-isl-stack">
          <span className="w3-who-sub">Pool</span>
          <span className="w3-ar-isl-pool__n">
            {enabled} {enabled === 1 ? 'model' : 'models'}
          </span>
        </span>
      </button>
      {busy ? (
        <button
          type="button"
          className="w3-isl-btn w3-ar-isl-stop"
          title="Stop generating"
          onClick={() => {
            arena.benchRun.abort();
            arena.blindRun.abort();
            arena.tournamentRun.abort();
          }}
        >
          <Icon name="stop" size="sm" />
        </button>
      ) : null}
    </>
  );

  const board = useMemo(() => replay(merged.rounds, merged.contenders), [merged]);

  return (
    <ModelsProvider
      connections={connections}
      recentModels={settings?.recentModels ?? []}
      chatModel={models.slots.chat}
      onRecentModels={app.rememberModels}
      favoriteModels={settings?.favoriteModels ?? []}
      onFavoriteModels={app.setFavoriteModels}
      pickerGroups={settings?.modelPickerGroups ?? {}}
      onPickerGroups={app.setModelPickerGroups}
    >
      <div
        ref={rootRef}
        className="wc3 w3-studio w3-ar"
        data-overlay-root
        data-screen={screen}
        style={firstAura as CSSProperties}
      >
        <div className="w3-aura" aria-hidden="true" />
        <div className="w3-wash" ref={washRef} aria-hidden="true" />

        <header className="w3-studio__top">
          <div className="w3-studio__side">
            <button type="button" className="w3-st-topbtn" onClick={controller.exitArena}>
              <Icon name="chevronLeft" size="sm" />
              {backLabel}
            </button>
            <nav className="w3-ar-tabs" aria-label="Arena">
              {SCREENS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={screen === id ? 'page' : undefined}
                  onClick={() => setScreen(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
          <div className="w3-studio__side w3-studio__side--right" />
        </header>

        <Island
          mode={islandMode}
          generating={busy}
          onCollapse={() => setMode(null)}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          wingsPinned={false}
          wingLeft={null}
          wingRight={null}
          panes={{
            rest: restPane,
            pool: (
              <ArenaPool
                arena={arena}
                rows={board.rows}
                nameOf={nameOf}
                colourOf={colourOf}
                onAdd={() => setMode('model')}
                onChange={onSettingsChange}
              />
            ),
            model: (
              <ModelPane
                active={islandMode === 'model'}
                value={null}
                head={<p className="w3-ar-mphead">Add a model to the pool</p>}
                onPick={addModel}
              />
            ),
          }}
        />

        <div className="w3-studio__body">
          <ErrorBoundary where="Arena" resetKeys={[screen]}>
            {arena.cardError ? (
              <p className="w3-ar-problem" role="alert">
                {arena.cardError}
              </p>
            ) : null}
            {screen === 'board' ? (
              <ArenaBoard
                arena={arena}
                characters={library.characters}
                nameOf={nameOf}
                colourOf={colourOf}
                sitting={sitting}
                sittingCost={sittingCost}
                onSettingsChange={onSettingsChange}
                onPlay={() => {
                  setBlind(true);
                  setScreen('bench');
                }}
              />
            ) : screen === 'bench' ? (
              <ArenaRoom
                arena={arena}
                blind={blind}
                onBlind={setBlind}
                characters={library.characters}
                presets={library.presets}
                personas={library.personas}
                nameOf={nameOf}
                colourOf={colourOf}
                priceOf={priceOf}
                onSettingsChange={onSettingsChange}
                onOpenPool={() => setMode('pool')}
              />
            ) : (
              <ArenaTournaments
                arena={arena}
                characters={library.characters}
                nameOf={nameOf}
                priceOf={priceOf}
              />
            )}
          </ErrorBoundary>
        </div>
      </div>
    </ModelsProvider>
  );
}
