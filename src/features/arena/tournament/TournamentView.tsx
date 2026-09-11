/**
 * One tournament: the bracket, the match room, and that cup's own standings.
 *
 * The page is the bracket until a match starts; then the match takes the room, because a blind
 * comparison wants the whole viewport (the duel scrolls inside itself and the verdict bar stays
 * docked, exactly as the benchmark does) and a bracket half-visible behind it would only invite
 * reading the tree while judging. Back returns to the tree, which now shows the winner advanced.
 */

import type { Contender, TournamentWithMatches, Verdict } from '@shared/types/arena.ts';
import { tournamentStageMatches } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useState } from 'react';
import type { ArenaDisplay } from '../display.ts';
import type { UseArenaRun } from '../useArenaRun.ts';
import { bracketView, stageName } from './bracket.ts';
import { tournamentLadder } from './ladder.ts';
import type { MatchRun } from './match.ts';
import { TournamentBracket } from './TournamentBracket.tsx';
import { TournamentMatchRoom } from './TournamentMatchRoom.tsx';

interface TournamentViewProps {
  tournament: TournamentWithMatches;
  contenders: readonly Contender[];
  characters: readonly CharacterSummary[];
  nameFor: (contenderId: string) => string;
  run: UseArenaRun;
  match: MatchRun | null;
  matchRevealed: boolean;
  matchRecording: boolean;
  matchError: string | null;
  holdUntilComplete: boolean;
  pending: boolean;
  preferredSlots: ReadonlyMap<string, number>;
  displayFor: (characterId: string) => ArenaDisplay;
  blockedReason: string | null;
  onBack: () => void;
  onPlay: (stage: number, matchIndex: number) => void;
  onVote: (verdict: Verdict) => void;
  onExitMatch: () => void;
  onAbandon: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
}

export function TournamentView({
  tournament,
  contenders,
  characters,
  nameFor,
  run,
  match,
  matchRevealed,
  matchRecording,
  matchError,
  holdUntilComplete,
  pending,
  preferredSlots,
  displayFor,
  blockedReason,
  onBack,
  onPlay,
  onVote,
  onExitMatch,
  onAbandon,
  onResume,
}: TournamentViewProps) {
  const [confirming, setConfirming] = useState(false);
  const view = bracketView(tournament);
  const frozen = tournament.status === 'abandoned';

  // Only a match that belongs to this tournament takes the room; a run left over from another
  // bracket must not appear over this one.
  const activeMatch = match && match.tournamentId === tournament.id ? match : null;

  if (activeMatch) {
    const plan = tournament.stages[activeMatch.stage];
    const characterId = plan?.characterId ?? '';
    const character = characters.find((entry) => entry.avatar === characterId) ?? null;
    const perStage = tournamentStageMatches(tournament.size, activeMatch.stage);

    return (
      <TournamentMatchRoom
        character={character}
        characterId={characterId}
        cue={plan?.cue ?? ''}
        stageLabel={`${stageName(tournament.size, activeMatch.stage)} · match ${activeMatch.matchIndex + 1} of ${perStage}`}
        run={run}
        pending={pending}
        revealed={matchRevealed}
        recording={matchRecording}
        error={matchError}
        deadHeat={activeMatch.deadHeat}
        holdUntilComplete={holdUntilComplete}
        displayFor={displayFor}
        preferredSlots={preferredSlots}
        onVote={onVote}
        onBack={onExitMatch}
      />
    );
  }

  const standings = tournamentLadder([tournament], contenders).filter((row) =>
    tournament.entrants.includes(row.contenderId),
  );

  return (
    <div className="arena-tour arena-tour--view">
      <header className="arena-tour__head">
        <div>
          <button type="button" className="wc-button wc-button--ghost" onClick={onBack}>
            All tournaments
          </button>
          <h2 className="arena-tour__title">{tournament.name}</h2>
          <p className="arena-tour__blurb">
            {view.complete
              ? `${nameFor(view.championId ?? '')} won this bracket.`
              : frozen
                ? 'Abandoned — the matches played still count on the ladder.'
                : `${view.playedMatches} of ${view.totalMatches} matches played.`}
          </p>
        </div>

        {view.complete ? (
          <span className="arena-tour__status">Completed</span>
        ) : frozen ? (
          <button type="button" className="wc-button" onClick={() => void onResume(tournament.id)}>
            Resume
          </button>
        ) : (
          <button
            type="button"
            className={confirming ? 'wc-button wc-button--danger' : 'wc-button'}
            onClick={() => {
              if (confirming) {
                setConfirming(false);
                void onAbandon(tournament.id);
              } else {
                setConfirming(true);
              }
            }}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? 'Confirm abandon' : 'Abandon'}
          </button>
        )}
      </header>

      {matchError ? (
        <p className="arena-error" role="alert">
          {matchError}
        </p>
      ) : null}
      {blockedReason ? <p className="wc-empty">{blockedReason}</p> : null}

      <TournamentBracket
        tournament={tournament}
        view={view}
        nameFor={nameFor}
        active={null}
        disabledReason={frozen || view.complete ? 'This tournament is not running.' : blockedReason}
        onPlay={onPlay}
      />

      <section className="arena-tour__group">
        <h3 className="arena-tour__grouptitle">Standings in this cup</h3>
        <ol className="arena-tour__cupstandings">
          {standings.map((row, index) => (
            <li key={row.contenderId}>
              <span className="arena-tour__rank">{index + 1}</span>
              <span className="arena-tour__name-plain">{nameFor(row.contenderId)}</span>
              <span className="arena-tour__points">{row.points} pts</span>
              {row.bestStage !== null ? (
                <span className="arena-tour__stageout">
                  {stageName(tournament.size, row.bestStage)}
                </span>
              ) : (
                <span className="arena-tour__stageout">—</span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
