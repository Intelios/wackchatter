/**
 * The Model Arena.
 *
 * A fourth destination beside the Studio, the Co-Creator and Stats, built on the same
 * shell skeleton for the same reason: what makes an area its own is what it does, not a
 * second palette.
 *
 * Read-through, but not read-only. Nothing here registers persistence — the Arena's run log
 * is session work and a blind verdict is one immediate POST, so there is no queue to flush
 * and nothing a failed flush could hide. Entering still flushes the chat's saves, because
 * this suspends the chat shell like its three siblings.
 *
 * The one piece of real orchestration is `pendingRun`. A run needs the card's detail *and*
 * its lorebooks loaded, and both arrive asynchronously — so starting is expressed as a
 * request that an effect fulfils once everything it needs is present, rather than as an
 * await that would either race the lore or block the click. Both modes go through it, which
 * is what keeps the blind round and the bench from drifting apart.
 */

import type { Connection } from '@shared/providers/types.ts';
import type { ArenaRound, ArenaSettings, Verdict } from '@shared/types/arena.ts';
import type { CardDataV2, CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Backdrop } from '../../components/Backdrop.tsx';
import { ChevronLeftIcon } from '../../layout/icons.tsx';
import { arenaApi, characterApi, presetApi } from '../../lib/api.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import type { EffectId } from '../backgrounds/effects.ts';
import { ParticleLayer } from '../backgrounds/ParticleLayer.tsx';
import { useLorebooks } from '../lore/useLorebooks.ts';
import { ArenaBench } from './ArenaBench.tsx';
import type { ArenaMode } from './ArenaTabs.tsx';
import { ArenaTabs } from './ArenaTabs.tsx';
import { BlindRound } from './BlindRound.tsx';
import { eligibleContenders, resolveContenders } from './contenders.ts';
import type { ArenaDisplay } from './display.ts';
import { createArenaDisplay, PASSTHROUGH_DISPLAY } from './display.ts';
import type { VerdictPreview } from './elo.ts';
import { previewVerdict, replay } from './elo.ts';
import { Leaderboard } from './Leaderboard.tsx';
import { PoolPanel } from './PoolPanel.tsx';
import { drawRound, type RoundDraw } from './pairing.ts';
import { buildScene, sceneSeedId } from './scene.ts';
import { poolSlots, viewSeries } from './series.ts';
import { useArenaRun } from './useArenaRun.ts';
import './ArenaShell.css';

/** A run waiting for its card and lorebooks to finish loading. */
interface PendingRun {
  /** Which bench it belongs to. The two never share a log — see `benchRun` / `blindRun`. */
  target: 'bench' | 'blind';
  runId: string;
  characterId: string;
  probe: string;
  contenderIds: string[];
  replace: boolean;
  draw?: RoundDraw;
}

interface ArenaShellProps {
  settings: ArenaSettings;
  onSettingsChange: (patch: Partial<ArenaSettings>) => void;
  connections: readonly Connection[];
  presets: readonly PresetSummary[];
  activePresetId: string | null;
  activePreset: Preset | null;
  characters: readonly CharacterSummary[];
  personas: readonly Persona[];
  books: readonly LorebookSummary[];
  globalLorebookIds: string[];
  worldInfoSettings: WorldInfoSettings;
  globalVariables: MacroVariableMap;
  regexScripts: readonly RegexScript[];
  /** Tags the user has hidden app-wide. The card picker must not offer them back. */
  hiddenTags: readonly string[];
  tokenizerEncoding?: 'auto' | 'o200k_base' | 'cl100k_base';
  streamingFps: number;
  backgroundUrl: string | null;
  backgroundBlur: number;
  backgroundDim: number;
  glass: boolean;
  effect: EffectId | null;
  effectLayer: 'behind' | 'front';
  onExit: () => void;
}

export function ArenaShell({
  settings,
  onSettingsChange,
  connections,
  presets,
  activePresetId,
  activePreset,
  characters,
  personas,
  books,
  globalLorebookIds,
  worldInfoSettings,
  globalVariables,
  regexScripts,
  hiddenTags,
  tokenizerEncoding,
  streamingFps,
  backgroundUrl,
  backgroundBlur,
  backgroundDim,
  glass,
  effect,
  effectLayer,
  onExit,
}: ArenaShellProps) {
  const [mode, setMode] = useState<ArenaMode>('bench');
  const [cards, setCards] = useState<Record<string, CardDataV2>>({});
  /**
   * Which card's detail and lorebooks are currently loaded.
   *
   * Separate from the bench's own picker below, because the blind round stages whatever it
   * draws — one lore loader serves both, and it can only be pointed at one card at a time.
   */
  const [stagedId, setStagedId] = useState<string | null>(null);
  /** The bench's chosen card, which a blind round must not silently change. */
  const [benchCharacterId, setBenchCharacterId] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  const [rounds, setRounds] = useState<ArenaRound[]>([]);
  const [roundsLoading, setRoundsLoading] = useState(true);

  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const [draw, setDraw] = useState<RoundDraw | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  /** Every verdict given this sitting, oldest first — the streak strip on the bar. */
  const [sessionVerdicts, setSessionVerdicts] = useState<Verdict[]>([]);
  /**
   * What the vote just did to the two ratings.
   *
   * Computed at the moment of the vote rather than read back after the POST: the reveal is
   * immediate, and waiting on a round-trip to say what you just bought would be theatre.
   */
  const [preview, setPreview] = useState<VerdictPreview | null>(null);
  /** Widen the canvas past the reading measure, for a monitor that has the room. */
  const [wide, setWide] = useState(false);

  // --- library -------------------------------------------------------------

  const refreshRounds = useCallback(async () => {
    try {
      setRounds(await arenaApi.rounds());
    } catch {
      // Keep the last good history: a stale leaderboard is better than a blank one, and
      // the failure is visible the moment a verdict fails to record.
    } finally {
      setRoundsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRounds();
  }, [refreshRounds]);

  useEffect(() => {
    if (!stagedId || cards[stagedId]) return;
    let cancelled = false;
    void characterApi
      .get(stagedId)
      .then((detail) => {
        if (!cancelled) setCards((current) => ({ ...current, [detail.avatar]: detail.card.data }));
      })
      .catch((err) => {
        if (!cancelled) setCardError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [stagedId, cards]);

  const stagedCard = stagedId ? (cards[stagedId] ?? null) : null;

  const lore = useLorebooks({
    character: stagedCard,
    globalIds: globalLorebookIds,
    books: books as LorebookSummary[],
  });

  // --- what a round runs with ----------------------------------------------

  const resolved = useMemo(
    () => resolveContenders(settings.contenders, connections),
    [connections, settings.contenders],
  );

  const persona = useMemo(
    () => personas.find((entry) => entry.id === settings.personaId) ?? null,
    [personas, settings.personaId],
  );

  /*
   * The unfiltered board, once, for everything outside the Leaderboard.
   *
   * The masthead wants each corner's record at the moment you are choosing, and the Pool
   * wants it on every entry card. Both read the same replay the Leaderboard does — there is
   * no second calculation here, only a second reader. The Leaderboard still replays its own,
   * because it can be filtered to one card and that is a different question.
   */
  const board = useMemo(() => replay(rounds, settings.contenders), [rounds, settings.contenders]);

  /**
   * Preferred corner colours, by pool order.
   *
   * Only the *preference*: which colour a contender actually wears is resolved per view
   * against the entrants in it, so two things on screen together can never collide. See
   * series.ts.
   */
  const preferredSlots = useMemo(() => poolSlots(settings.contenders), [settings.contenders]);

  const poolColours = useMemo(
    () =>
      viewSeries(
        settings.contenders.map((entry) => entry.id),
        preferredSlots,
      ),
    [preferredSlots, settings.contenders],
  );

  const presetId =
    settings.presetId && presets.some((entry) => entry.id === settings.presetId)
      ? settings.presetId
      : activePresetId;

  const [loadedPreset, setLoadedPreset] = useState<{ id: string; value: Preset } | null>(null);
  useEffect(() => {
    if (!presetId || presetId === activePresetId) return;
    let cancelled = false;
    void presetApi
      .get(presetId)
      .then((value) => {
        if (!cancelled) setLoadedPreset({ id: presetId, value });
      })
      .catch(() => {
        if (!cancelled) setLoadedPreset(null);
      });
    return () => {
      cancelled = true;
    };
  }, [presetId, activePresetId]);

  const preset =
    presetId === activePresetId
      ? activePreset
      : loadedPreset?.id === presetId
        ? loadedPreset.value
        : null;

  /*
   * One tokenizer for the whole run, taken from the first usable contender.
   *
   * Which model it is modelled on does not affect fairness: every column is packed from the
   * one assembled prompt, so a counter that runs slightly hot or cold moves both sides
   * identically. It only wants to be *representative*, which the first entrant is.
   */
  const counterModel = resolved.find((entry) => entry.connection)?.connection?.model ?? '';
  const countTokens = useTokenizer(counterModel, tokenizerEncoding);

  const runOptions = {
    preset,
    persona,
    worldInfoSettings,
    globalVariables,
    regexScripts,
    countTokens,
    streamingFps,
    // Requesting a stream is not the same as rendering one: a held blind round still
    // streams so that Stop keeps whatever had arrived.
    streaming: preset?.stream_openai !== false,
  };

  /*
   * One engine per mode, deliberately not shared.
   *
   * They looked like one thing — same scene, same columns — but their logs are opposites:
   * the bench accumulates every comparison you have made, and a blind round keeps exactly
   * one and replaces it. Sharing a reducer meant a benchmark round silently erased the
   * bench's history, and switching tabs mid-session showed the bench's labelled replies
   * masked as A and B, as though there were something to vote on.
   */
  const benchRun = useArenaRun(runOptions);
  const blindRun = useArenaRun(runOptions);

  const benchRef = useRef(benchRun);
  benchRef.current = benchRun;
  const blindRef = useRef(blindRun);
  blindRef.current = blindRun;

  // --- readiness ------------------------------------------------------------

  // Returning to the bench points the loader back at its card, so Compare is not gated on
  // whatever the last blind round happened to draw.
  useEffect(() => {
    if (mode === 'bench' && benchCharacterId && stagedId !== benchCharacterId) {
      setStagedId(benchCharacterId);
    }
  }, [benchCharacterId, mode, stagedId]);

  const benchReady =
    Boolean(benchCharacterId) &&
    stagedId === benchCharacterId &&
    Boolean(stagedCard) &&
    !lore.pending;
  const benchReadyReason = !benchCharacterId
    ? 'Choose a character first.'
    : !stagedCard || stagedId !== benchCharacterId
      ? 'Loading the card…'
      : lore.pending
        ? 'Loading this card’s lorebooks…'
        : null;

  const setupReason = useMemo(() => {
    if (!preset) return 'No preset is loaded.';
    if (connections.length === 0) return 'Add a connection before comparing models.';
    if (resolved.filter((entry) => entry.connection).length < 2) {
      return 'Add at least two usable contenders in Pool.';
    }
    return null;
  }, [connections.length, preset, resolved]);

  // --- starting a run -------------------------------------------------------

  /**
   * Fulfil a pending run once its card and lorebooks are present.
   *
   * The wait is not cosmetic: a round that generated before the card's linked book arrived
   * would be judging models against lore a real chat would have given them.
   */
  useEffect(() => {
    if (!pendingRun) return;
    const card = cards[pendingRun.characterId];
    if (!card || lore.pending) return;

    const columns = pendingRun.contenderIds.flatMap((id) => {
      const entry = resolved.find((item) => item.contender.id === id);
      return entry?.connection
        ? [{ contender: entry.contender, connection: entry.connection }]
        : [];
    });

    setPendingRun(null);
    if (pendingRun.target === 'blind') {
      if (pendingRun.draw) setDraw(pendingRun.draw);
      setRevealed(false);
      setPreview(null);
      setRecordError(null);
    }
    const engine = pendingRun.target === 'blind' ? blindRef.current : benchRef.current;
    void engine.start({
      runId: pendingRun.runId,
      characterId: pendingRun.characterId,
      card,
      probe: pendingRun.probe,
      columns,
      worldInfoSources: lore.sourcesForPersona(persona?.lorebookId ?? undefined),
      replace: pendingRun.replace,
    });
  }, [cards, lore, pendingRun, persona, resolved]);

  const requestRun = useCallback((request: Omit<PendingRun, 'runId'>) => {
    setStagedId(request.characterId);
    setPendingRun({ ...request, runId: crypto.randomUUID() });
  }, []);

  const startBench = useCallback(
    (probe: string, contenderIds: string[], characterId: string) => {
      requestRun({ target: 'bench', characterId, probe, contenderIds, replace: false });
    },
    [requestRun],
  );

  // --- blind rounds ---------------------------------------------------------

  /** The cards a blind round may draw. An empty pool means the whole library. */
  const drawableCards = useMemo(() => {
    const library = characters.map((entry) => entry.avatar);
    if (settings.cardPool.length === 0) return library;
    // Intersected with the library, so a pool entry whose card was deleted cannot be drawn
    // into a round that would then fail to load it.
    return settings.cardPool.filter((avatar) => library.includes(avatar));
  }, [characters, settings.cardPool]);

  const blindReason = useMemo(() => {
    if (setupReason) return setupReason;
    if (eligibleContenders(resolved).length < 2) {
      return 'At least two contenders must be enabled for the blind draw.';
    }
    if (drawableCards.length === 0) return 'No cards to draw from. Add some in Pool.';
    if (settings.probes.length === 0) return 'No probes to ask. Add one in Pool.';
    return null;
  }, [drawableCards.length, resolved, settings.probes.length, setupReason]);

  const nextRound = useCallback(() => {
    if (blindReason || pendingRun || blindRun.busy) return;
    const next = drawRound({
      contenders: eligibleContenders(resolved),
      cards: drawableCards,
      probes: settings.probes,
      rounds,
      seed: crypto.randomUUID(),
    });
    if (!next) return;

    requestRun({
      target: 'blind',
      characterId: next.characterId,
      probe: next.probe.text,
      contenderIds: [next.left.id, next.right.id],
      replace: true,
      draw: next,
    });
  }, [
    blindReason,
    blindRun.busy,
    drawableCards,
    pendingRun,
    requestRun,
    resolved,
    rounds,
    settings.probes,
  ]);

  /** The run ID that was last voted on, to prevent double recording the same round. */
  const votedRunIdRef = useRef<string | null>(null);

  const vote = useCallback(
    (verdict: Verdict) => {
      const current = blindRun.state.runs[0];
      const left = current?.entries[0];
      const right = current?.entries[1];
      if (!current || !left || !right) return;
      if (votedRunIdRef.current === current.id) return;
      votedRunIdRef.current = current.id;

      const record = {
        characterId: current.characterId,
        probe: current.probe,
        left: {
          contenderId: left.contenderId,
          model: left.model,
          provider: left.provider,
          text: left.text,
        },
        right: {
          contenderId: right.contenderId,
          model: right.model,
          provider: right.provider,
          text: right.text,
        },
        verdict,
      };

      // Revealed immediately. The decision is already made, and making someone wait on a
      // local round-trip to learn who wrote what would be theatre.
      setRevealed(true);
      // What the vote bought, from the same replay every other rating comes from. Computed
      // against the history as it stands *before* the POST, which is exactly the history the
      // recorded round will be appended to.
      setPreview(previewVerdict(rounds, settings.contenders, record));
      setSessionVerdicts((current) => [...current, verdict]);
      setRecording(true);
      setRecordError(null);

      void arenaApi
        .record(record)
        .then(() => refreshRounds())
        .catch((err) => {
          votedRunIdRef.current = null;
          setRecordError(`This round was not recorded: ${(err as Error).message}`);
        })
        .finally(() => setRecording(false));
    },
    [blindRun.state.runs, refreshRounds, rounds, settings.contenders],
  );

  const clearHistory = useCallback(() => {
    void arenaApi
      .clear()
      .then(() => refreshRounds())
      .catch((err) => setRecordError((err as Error).message));
  }, [refreshRounds]);

  const purgeContender = useCallback(
    (contenderId: string) => {
      if (settings.contenders.some((entry) => entry.id === contenderId)) {
        onSettingsChange({
          contenders: settings.contenders.filter((entry) => entry.id !== contenderId),
        });
      }
      void arenaApi
        .deleteContender(contenderId)
        .then(() => refreshRounds())
        .catch((err) => setRecordError((err as Error).message));
    },
    [onSettingsChange, refreshRounds, settings.contenders],
  );

  // --- rendering ------------------------------------------------------------

  /**
   * The display transform for one card's replies, memoised per card.
   *
   * Per card rather than one for the screen: the bench's log can hold runs against several
   * cards, and a regex replacement containing `{{char}}` must expand to the card that run
   * was actually about.
   */
  const displays = useMemo(() => {
    const map = new Map<string, ArenaDisplay>();
    for (const [characterId, card] of Object.entries(cards)) {
      map.set(
        characterId,
        createArenaDisplay({
          card,
          preset,
          persona,
          // The scene without a probe: the macro environment only reads the card, the
          // persona and the preset, so the user's turn contributes nothing to it.
          messages: buildScene({ card, probe: '' }),
          globalVariables,
          regexScripts,
          seed: sceneSeedId(characterId),
        }),
      );
    }
    return map;
  }, [cards, globalVariables, persona, preset, regexScripts]);

  const displayFor = useCallback(
    (characterId: string) => displays.get(characterId) ?? PASSTHROUGH_DISPLAY,
    [displays],
  );

  return (
    <div
      className="arena-shell"
      data-overlay-root
      data-wide={wide}
      data-glass={backgroundUrl !== null && glass}
      style={
        {
          '--wc-bg-blur': `${backgroundBlur}px`,
          '--wc-bg-dim': backgroundDim,
        } as CSSProperties
      }
    >
      <Backdrop url={backgroundUrl} />
      {backgroundUrl ? <div className="shell__scrim" aria-hidden="true" /> : null}

      <header className="arena-shell__bar">
        <div className="arena-shell__navigation">
          <button type="button" className="wc-button wc-button--ghost" onClick={onExit}>
            <ChevronLeftIcon />
            Exit Arena
          </button>
        </div>

        {/*
         * A real tab set, so real tabs — see ArenaTabs for the aria-selected reasoning and
         * the sliding underline.
         */}
        <ArenaTabs mode={mode} onChange={setMode} />

        <div className="arena-shell__actions">
          {benchRun.busy || blindRun.busy ? (
            <span className="arena-shell__busy">Generating…</span>
          ) : null}
        </div>
      </header>

      {/*
       * The mode is on the scroll container because one of the four does not scroll: a blind
       * round is a room you are in until you vote, and a vote bar that can leave the viewport
       * turns a forty-round sitting into forty small hunts for it.
       */}
      <div className="arena-shell__body" data-mode={mode}>
        {cardError ? (
          <p className="arena-error" role="alert">
            {cardError}
          </p>
        ) : null}

        {mode === 'bench' ? (
          <ArenaBench
            settings={settings}
            onSettingsChange={onSettingsChange}
            characters={characters}
            resolved={resolved}
            run={benchRun}
            characterId={benchCharacterId}
            onSelectCharacter={(avatar) => {
              setBenchCharacterId(avatar || null);
              setStagedId(avatar || null);
            }}
            ready={benchReady}
            readyReason={benchReadyReason}
            displayFor={displayFor}
            onRun={startBench}
            blockedReason={setupReason}
            rows={board.rows}
            preferredSlots={preferredSlots}
            wide={wide}
            onWideChange={setWide}
          />
        ) : null}

        {mode === 'blind' ? (
          <BlindRound
            settings={settings}
            characters={characters}
            run={blindRun}
            pending={pendingRun?.target === 'blind'}
            draw={draw}
            revealed={revealed}
            recording={recording}
            recordError={recordError}
            displayFor={displayFor}
            onNext={nextRound}
            onVote={vote}
            blockedReason={blindReason}
            sessionVerdicts={sessionVerdicts}
            preview={preview}
            preferredSlots={preferredSlots}
          />
        ) : null}

        {mode === 'board' ? (
          <Leaderboard
            rounds={rounds}
            contenders={settings.contenders}
            characters={characters}
            loading={roundsLoading}
            preferredSlots={preferredSlots}
            displayFor={displayFor}
            onPurgeContender={purgeContender}
          />
        ) : null}

        {mode === 'pool' ? (
          <PoolPanel
            settings={settings}
            onSettingsChange={onSettingsChange}
            resolved={resolved}
            connections={connections}
            characters={characters}
            personas={personas}
            presets={presets}
            activePresetId={activePresetId}
            preset={preset}
            rounds={rounds}
            rows={board.rows}
            colours={poolColours}
            hiddenTags={hiddenTags}
            onClearHistory={clearHistory}
            onPurgeContender={purgeContender}
          />
        ) : null}
      </div>

      {/* The shell's last static child; see the AppShell comment for the stacking rule. */}
      <ParticleLayer effect={effect} layer={effectLayer} />
    </div>
  );
}
