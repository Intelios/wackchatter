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
import type { ArenaSettings } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { CSSProperties } from 'react';
import { Backdrop } from '../../components/Backdrop.tsx';
import { ChevronLeftIcon } from '../../layout/icons.tsx';
import type { EffectId } from '../backgrounds/effects.ts';
import { ParticleLayer } from '../backgrounds/ParticleLayer.tsx';
import { ArenaBench } from './ArenaBench.tsx';
import { ArenaTabs } from './ArenaTabs.tsx';
import { BlindRound } from './BlindRound.tsx';
import { Leaderboard } from './Leaderboard.tsx';
import { PoolPanel } from './PoolPanel.tsx';
import { TournamentPanel } from './tournament/TournamentPanel.tsx';
import { useArena } from './useArena.ts';
import './ArenaShell.css';

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
  const arena = useArena({
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
    tokenizerEncoding,
    streamingFps,
  });
  const {
    mode,
    setMode,
    setStagedId,
    benchCharacterId,
    setBenchCharacterId,
    cardError,
    rounds,
    roundsLoading,
    tournaments,
    tournamentsLoading,
    tournamentId,
    setTournamentId,
    matchRun,
    matchRevealed,
    matchRecording,
    matchError,
    pendingRun,
    draw,
    revealed,
    recording,
    recordError,
    sessionVerdicts,
    preview,
    wide,
    setWide,
    resolved,
    merged,
    eligible,
    board,
    preferredSlots,
    poolColours,
    preset,
    benchRun,
    blindRun,
    tournamentRun,
    benchReady,
    benchReadyReason,
    setupReason,
    nameFor,
    startBench,
    blindReason,
    nextRound,
    vote,
    clearHistory,
    purgeContender,
    tournamentBlockedReason,
    careerLadder,
    startTournamentMatch,
    voteMatch,
    exitMatch,
    startBlockedReason,
    entrantBlockedReason,
    createTournament,
    abandonTournament,
    resumeTournament,
    deleteTournament,
    renameTournament,
    displayFor,
  } = arena;

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
          {benchRun.busy || blindRun.busy || tournamentRun.busy ? (
            <span className="arena-shell__busy">Generating…</span>
          ) : null}
        </div>
      </header>

      {/*
       * The mode is on the scroll container because two of the five do not scroll: a blind
       * round and a tournament match are rooms you are in until you vote, and a vote bar that
       * can leave the viewport turns a long sitting into a hunt for it. A tournament match
       * borrows the blind layout for exactly that reason — same duel, same docked bar — so the
       * body is told `blind` while a match is in the room, however the tab is named.
       */}
      <div
        className="arena-shell__body"
        data-mode={mode === 'tournament' && matchRun ? 'blind' : mode}
      >
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
            canonical={merged.canonical}
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

        {mode === 'tournament' ? (
          <TournamentPanel
            tournaments={tournaments}
            loading={tournamentsLoading}
            ladder={careerLadder}
            contenders={settings.contenders}
            eligible={eligible}
            characters={characters}
            probes={settings.probes}
            nameFor={nameFor}
            newBlockedReason={tournamentBlockedReason}
            tournamentId={tournamentId}
            onSelectTournament={setTournamentId}
            run={tournamentRun}
            match={matchRun}
            matchRevealed={matchRevealed}
            matchRecording={matchRecording}
            matchError={matchError}
            holdUntilComplete={settings.holdBlindUntilComplete}
            pending={pendingRun?.target === 'tournament'}
            preferredSlots={preferredSlots}
            displayFor={displayFor}
            startBlockedReason={startBlockedReason}
            entrantBlockedReason={entrantBlockedReason}
            onStartMatch={startTournamentMatch}
            onVote={voteMatch}
            onExitMatch={exitMatch}
            onCreate={createTournament}
            onAbandon={abandonTournament}
            onResume={resumeTournament}
            onDelete={deleteTournament}
            onRename={renameTournament}
          />
        ) : null}

        {mode === 'board' ? (
          <Leaderboard
            rounds={rounds}
            contenders={settings.contenders}
            merged={settings.mergedContenders}
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
            characters={characters}
            personas={personas}
            presets={presets}
            activePresetId={activePresetId}
            preset={preset}
            rounds={rounds}
            rows={board.rows}
            merged={merged}
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
