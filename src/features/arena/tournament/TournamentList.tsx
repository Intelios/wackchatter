/**
 * The Tournament tab's home: every bracket, and the career ladder they feed.
 *
 * Active and completed brackets are separate lists because they are separate jobs — one is
 * something to get back to, the other is something to look up. Abandoned brackets sit with
 * the completed ones: abandoning freezes a bracket rather than erasing it, so its matches
 * keep paying into the ladder and it can still be resumed.
 *
 * Destructive actions are two-click in place, never a modal — the app's rule — and "abandon"
 * counts as destructive-looking enough to confirm because it is the one button here that
 * changes a running bracket's state.
 */

import type { TournamentWithMatches } from '@shared/types/arena.ts';
import { useState } from 'react';
import { bracketView } from './bracket.ts';
import type { LadderRow } from './ladder.ts';
import { TournamentLadder } from './TournamentLadder.tsx';

interface TournamentListProps {
  tournaments: readonly TournamentWithMatches[];
  loading: boolean;
  ladder: readonly LadderRow[];
  nameFor: (contenderId: string) => string;
  /** Why a tournament cannot be created. Null when the New button is live. */
  newBlockedReason: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onAbandon: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}

export function TournamentList({
  tournaments,
  loading,
  ladder,
  nameFor,
  newBlockedReason,
  onOpen,
  onNew,
  onAbandon,
  onResume,
  onDelete,
  onRename,
}: TournamentListProps) {
  const running: TournamentWithMatches[] = [];
  const archived: TournamentWithMatches[] = [];

  for (const tournament of tournaments) {
    const complete = bracketView(tournament).complete;
    const frozen = tournament.status === 'abandoned';
    if (!complete && !frozen) running.push(tournament);
    else archived.push(tournament);
  }

  return (
    <div className="arena-tour">
      <header className="arena-tour__head">
        <div>
          <h2 className="arena-tour__title">Tournaments</h2>
          <p className="arena-tour__blurb">
            Bracket-style elimination. Every match is judged blind, and wins earn stage-weighted
            points on a ladder kept separate from the benchmark's ratings — a loss costs nothing.
          </p>
        </div>
        <button
          type="button"
          className="wc-button wc-button--primary"
          disabled={newBlockedReason !== null}
          title={newBlockedReason ?? 'Draw a new bracket'}
          onClick={onNew}
        >
          New tournament
        </button>
      </header>

      {loading ? <p className="wc-empty">Loading tournaments…</p> : null}

      {!loading && tournaments.length === 0 ? (
        <p className="wc-empty">
          No tournaments yet. Start one and it will draw a random bracket from your enabled
          contenders.
        </p>
      ) : null}

      {running.length > 0 ? (
        <section className="arena-tour__group">
          <h3 className="arena-tour__grouptitle">In progress</h3>
          <div className="arena-tour__cards">
            {running.map((tournament) => (
              <TournamentCard
                key={tournament.id}
                tournament={tournament}
                nameFor={nameFor}
                onOpen={onOpen}
                onAbandon={onAbandon}
                onResume={onResume}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </div>
        </section>
      ) : null}

      {archived.length > 0 ? (
        <section className="arena-tour__group">
          <h3 className="arena-tour__grouptitle">Finished</h3>
          <div className="arena-tour__cards">
            {archived.map((tournament) => (
              <TournamentCard
                key={tournament.id}
                tournament={tournament}
                nameFor={nameFor}
                onOpen={onOpen}
                onAbandon={onAbandon}
                onResume={onResume}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="arena-tour__group">
        <h3 className="arena-tour__grouptitle">Career points</h3>
        <TournamentLadder rows={ladder} tournaments={tournaments} nameFor={nameFor} />
      </section>
    </div>
  );
}

interface TournamentCardProps {
  tournament: TournamentWithMatches;
  nameFor: (contenderId: string) => string;
  onOpen: (id: string) => void;
  onAbandon: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}

function TournamentCard({
  tournament,
  nameFor,
  onOpen,
  onAbandon,
  onResume,
  onDelete,
  onRename,
}: TournamentCardProps) {
  const view = bracketView(tournament);
  const finished = view.complete;
  const frozen = tournament.status === 'abandoned';

  const [confirming, setConfirming] = useState<'abandon' | 'delete' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(tournament.name);
  const [error, setError] = useState<string | null>(null);

  const run = (action: Promise<void>) => {
    setError(null);
    void action.catch((err) => setError((err as Error).message));
  };

  const status = finished ? 'Completed' : frozen ? 'Abandoned' : 'In progress';

  return (
    <article
      className="arena-tour__card"
      data-status={finished ? 'complete' : frozen ? 'frozen' : 'active'}
    >
      <header className="arena-tour__cardhead">
        {renaming ? (
          <form
            className="arena-tour__rename"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.trim()) return;
              setRenaming(false);
              run(onRename(tournament.id, draft.trim()));
            }}
          >
            <input
              className="wc-input"
              value={draft}
              aria-label="Tournament name"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="wc-button wc-button--primary">
              Save
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              onClick={() => {
                setDraft(tournament.name);
                setRenaming(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="arena-tour__cardname"
            onClick={() => setRenaming(true)}
            title="Rename this tournament"
          >
            {tournament.name}
          </button>
        )}
        <span className="arena-tour__status">{status}</span>
      </header>

      <p className="arena-tour__meta">
        {tournament.size} contenders · {view.playedMatches} of {view.totalMatches} matches played
        {finished && view.championId ? (
          <>
            {' · '}
            <strong>{nameFor(view.championId)}</strong> won
          </>
        ) : null}
      </p>

      {error ? (
        <p className="arena-error" role="alert">
          {error}
        </p>
      ) : null}

      <footer className="arena-tour__cardactions">
        <button
          type="button"
          className="wc-button wc-button--primary"
          onClick={() => onOpen(tournament.id)}
        >
          {finished || frozen ? 'View' : 'Open'}
        </button>

        {!finished && !frozen ? (
          <button
            type="button"
            className={confirming === 'abandon' ? 'wc-button wc-button--danger' : 'wc-button'}
            onClick={() => {
              if (confirming === 'abandon') {
                setConfirming(null);
                run(onAbandon(tournament.id));
              } else {
                setConfirming('abandon');
              }
            }}
            onBlur={() => setConfirming(null)}
          >
            {confirming === 'abandon' ? 'Confirm abandon' : 'Abandon'}
          </button>
        ) : null}

        {frozen && !finished ? (
          <button type="button" className="wc-button" onClick={() => run(onResume(tournament.id))}>
            Resume
          </button>
        ) : null}

        <button
          type="button"
          className={
            confirming === 'delete' ? 'wc-button wc-button--danger' : 'wc-button wc-button--ghost'
          }
          onClick={() => {
            if (confirming === 'delete') {
              setConfirming(null);
              run(onDelete(tournament.id));
            } else {
              setConfirming('delete');
            }
          }}
          onBlur={() => setConfirming(null)}
        >
          {confirming === 'delete' ? 'Confirm delete' : 'Delete'}
        </button>
      </footer>
    </article>
  );
}
