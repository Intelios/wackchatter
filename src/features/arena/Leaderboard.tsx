/**
 * The leaderboard.
 *
 * Every number on this screen is replayed from the recorded rounds on render — there is no
 * stored rating that could have drifted from the history behind it. See `replayRatings`.
 *
 * Two presentation rules carry real weight. Provisional ratings are ranked below
 * established ones and marked, because a lucky two-round entrant sitting at the top would
 * read as a verdict. And a contender that has been deleted from the pool still appears,
 * labelled with the model it actually ran — a round never drops out of its own history.
 */

import type { ArenaRound, Contender } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useMemo, useState } from 'react';
import { contenderLabel } from './contenders.ts';
import { PROVISIONAL_ROUNDS, replay } from './elo.ts';
import { RatingChart } from './RatingChart.tsx';

interface LeaderboardProps {
  rounds: readonly ArenaRound[];
  contenders: readonly Contender[];
  characters: readonly CharacterSummary[];
  loading: boolean;
}

export function Leaderboard({ rounds, contenders, characters, loading }: LeaderboardProps) {
  const [cardFilter, setCardFilter] = useState('');

  const cardsPlayed = useMemo(() => {
    const seen = new Map<string, number>();
    for (const round of rounds) {
      seen.set(round.characterId, (seen.get(round.characterId) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [rounds]);

  const filtered = useMemo(
    () => (cardFilter ? rounds.filter((round) => round.characterId === cardFilter) : rounds),
    [cardFilter, rounds],
  );

  /*
   * The pool is seeded only for the unfiltered board.
   *
   * Filtered to one card, a contender that has never fought on it would appear at a flat
   * 1500 as if it had been measured there — which is the opposite of what the filter is
   * being used to find out.
   */
  const { rows, series } = useMemo(
    () => replay(filtered, cardFilter ? [] : contenders),
    [cardFilter, contenders, filtered],
  );

  const nameOf = (contenderId: string, model: string): string => {
    const contender = contenders.find((entry) => entry.id === contenderId);
    // A deleted contender falls back to what it actually ran, never to a bare uuid.
    return contender ? contenderLabel(contender) : model || contenderId;
  };

  return (
    <div className="arena-board">
      <header className="arena-board__head">
        <div>
          <h2>Leaderboard</h2>
          <p className="wc-hint">
            {rounds.length === 0
              ? 'No blind rounds yet. Ratings appear once you have judged a few.'
              : `Replayed from ${rounds.length} blind ${rounds.length === 1 ? 'round' : 'rounds'}. Nothing is stored but the rounds themselves.`}
          </p>
        </div>

        {cardsPlayed.length > 1 ? (
          <div className="arena-board__filter">
            <label className="wc-label" htmlFor="arena-board-card">
              On card
            </label>
            <select
              id="arena-board-card"
              className="wc-select"
              value={cardFilter}
              onChange={(event) => setCardFilter(event.target.value)}
            >
              <option value="">Every card</option>
              {cardsPlayed.map(([avatar, count]) => (
                <option key={avatar} value={avatar}>
                  {characters.find((entry) => entry.avatar === avatar)?.name ?? avatar} ({count})
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>

      {loading ? <p className="wc-empty">Reading the history…</p> : null}

      {/* Above the table on purpose: the shape is the thing you came to look at, and the
          exact figures are one glance further down. */}
      {!loading && rows.length > 0 ? (
        <RatingChart series={series} rows={rows} nameOf={nameOf} />
      ) : null}

      {!loading && rows.length === 0 ? (
        <p className="wc-empty">Nothing to rank yet.</p>
      ) : (
        <table className="stats-table arena-board__table">
          <thead>
            <tr>
              <th>Contender</th>
              <th>Model</th>
              <th>Rating</th>
              <th>Rounds</th>
              <th>W</th>
              <th>L</th>
              <th>T</th>
              <th title="Rounds where you rejected both replies. Recorded, never rated.">
                Rejected
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.contenderId} data-provisional={row.provisional}>
                <th scope="row">{nameOf(row.contenderId, row.model)}</th>
                <td className="stats-table__mono" title={`${row.provider} · ${row.model}`}>
                  {row.model || '—'}
                </td>
                <td>
                  {row.rating}
                  {row.provisional ? (
                    <span
                      className="arena-board__provisional"
                      title={`Provisional — fewer than ${PROVISIONAL_ROUNDS} rated rounds. Treat it as noise until it settles.`}
                    >
                      ?
                    </span>
                  ) : null}
                </td>
                <td>{row.rounds}</td>
                <td>{row.wins}</td>
                <td>{row.losses}</td>
                <td>{row.ties}</td>
                <td>{row.rejected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.some((row) => row.provisional) ? (
        <p className="wc-hint">
          A <span className="arena-board__provisional">?</span> marks a provisional rating: fewer
          than {PROVISIONAL_ROUNDS} rated rounds behind it. Those rows are ranked below established
          ones however high the number goes, because five rounds of Elo is noise.
        </p>
      ) : null}
    </div>
  );
}
