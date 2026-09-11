/**
 * The Tournament tab's router: list, creation wizard, or one bracket.
 *
 * Which one shows is a function of whether a tournament is selected and whether the wizard is
 * open — an id, not a boolean-plus-tab, so the two can never disagree about where you are.
 */

import type {
  ArenaProbe,
  Contender,
  TournamentSize,
  TournamentStage,
  TournamentWithMatches,
  Verdict,
} from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useState } from 'react';
import type { ArenaDisplay } from '../display.ts';
import type { UseArenaRun } from '../useArenaRun.ts';
import type { LadderRow } from './ladder.ts';
import type { MatchRun } from './match.ts';
import { TournamentList } from './TournamentList.tsx';
import { TournamentView } from './TournamentView.tsx';
import { TournamentWizard } from './TournamentWizard.tsx';

interface TournamentPanelProps {
  tournaments: readonly TournamentWithMatches[];
  loading: boolean;
  ladder: readonly LadderRow[];
  contenders: readonly Contender[];
  eligible: readonly Contender[];
  characters: readonly CharacterSummary[];
  /** The Pool's saved cues, so a stage can reuse one rather than retype it. */
  probes: readonly ArenaProbe[];
  nameFor: (contenderId: string) => string;
  /** Why a tournament cannot be created. Null when one can. */
  newBlockedReason: string | null;
  tournamentId: string | null;
  onSelectTournament: (id: string | null) => void;
  run: UseArenaRun;
  match: MatchRun | null;
  matchRevealed: boolean;
  matchRecording: boolean;
  matchError: string | null;
  holdUntilComplete: boolean;
  pending: boolean;
  preferredSlots: ReadonlyMap<string, number>;
  displayFor: (characterId: string) => ArenaDisplay;
  startBlockedReason: (tournament: TournamentWithMatches) => string | null;
  onStartMatch: (tournamentId: string, stage: number, matchIndex: number) => void;
  onVote: (verdict: Verdict) => void;
  onExitMatch: () => void;
  onCreate: (input: {
    name: string;
    size: TournamentSize;
    entrants: string[];
    stages: TournamentStage[];
  }) => Promise<void>;
  onAbandon: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}

export function TournamentPanel({
  tournaments,
  loading,
  ladder,
  contenders,
  eligible,
  characters,
  probes,
  nameFor,
  newBlockedReason,
  tournamentId,
  onSelectTournament,
  run,
  match,
  matchRevealed,
  matchRecording,
  matchError,
  holdUntilComplete,
  pending,
  preferredSlots,
  displayFor,
  startBlockedReason,
  onStartMatch,
  onVote,
  onExitMatch,
  onCreate,
  onAbandon,
  onResume,
  onDelete,
  onRename,
}: TournamentPanelProps) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const selected = tournaments.find((entry) => entry.id === tournamentId) ?? null;

  if (wizardOpen) {
    return (
      <TournamentWizard
        eligible={eligible}
        characters={characters}
        probes={probes}
        labelFor={nameFor}
        onCancel={() => setWizardOpen(false)}
        onCreate={async (input) => {
          await onCreate(input);
          setWizardOpen(false);
        }}
      />
    );
  }

  if (selected) {
    return (
      <TournamentView
        tournament={selected}
        contenders={contenders}
        characters={characters}
        nameFor={nameFor}
        run={run}
        match={match}
        matchRevealed={matchRevealed}
        matchRecording={matchRecording}
        matchError={matchError}
        holdUntilComplete={holdUntilComplete}
        pending={pending}
        preferredSlots={preferredSlots}
        displayFor={displayFor}
        blockedReason={startBlockedReason(selected)}
        onBack={() => onSelectTournament(null)}
        onPlay={(stage, matchIndex) => onStartMatch(selected.id, stage, matchIndex)}
        onVote={onVote}
        onExitMatch={onExitMatch}
        onAbandon={onAbandon}
        onResume={onResume}
      />
    );
  }

  return (
    <TournamentList
      tournaments={tournaments}
      loading={loading}
      ladder={ladder}
      nameFor={nameFor}
      newBlockedReason={newBlockedReason}
      onOpen={onSelectTournament}
      onNew={() => setWizardOpen(true)}
      onAbandon={onAbandon}
      onResume={onResume}
      onDelete={onDelete}
      onRename={onRename}
    />
  );
}
