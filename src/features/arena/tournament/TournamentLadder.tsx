/**
 * The career tournament ladder.
 *
 * Points accumulate with each stage won and never fall, so this reads as a record of what
 * each contender has achieved rather than an estimate of how strong it is — the deliberate
 * complement to the leaderboard's rating. Ties are broken by the head-to-head result between
 * the tied contenders, then by who got there first; `ladder.ts` decides that, this only draws
 * it.
 *
 * A row expands to show where the points came from. Only tournaments that paid anything are
 * listed: a zero is the absence of a result, not a result.
 */

import type { TournamentWithMatches } from '@shared/types/arena.ts';
import { Fragment, useState } from 'react';
import type { LadderRow } from './ladder.ts';

interface TournamentLadderProps {
  rows: readonly LadderRow[];
  tournaments: readonly TournamentWithMatches[];
  nameFor: (contenderId: string) => string;
}

export function TournamentLadder({ rows, tournaments, nameFor }: TournamentLadderProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const nameOfTournament = new Map(tournaments.map((entry) => [entry.id, entry.name]));

  const toggle = (contenderId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(contenderId)) next.delete(contenderId);
      else next.add(contenderId);
      return next;
    });
  };

  if (rows.length === 0) {
    return <p className="wc-empty">No contenders yet. Add some in Pool.</p>;
  }

  return (
    <table className="arena-tour__ladder">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Contender</th>
          <th scope="col">Points</th>
          <th scope="col">W</th>
          <th scope="col">L</th>
          <th scope="col">Cups</th>
          <th scope="col">Won</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const open = expanded.has(row.contenderId);
          const breakdown = row.byTournament;
          return (
            <Fragment key={row.contenderId}>
              <tr>
                <td className="arena-tour__rank">{index + 1}</td>
                <th scope="row" className="arena-tour__who">
                  {breakdown.length > 0 ? (
                    <button
                      type="button"
                      className="arena-tour__disclose"
                      aria-expanded={open}
                      onClick={() => toggle(row.contenderId)}
                    >
                      <span className="arena-tour__chevron" aria-hidden="true">
                        {open ? '▾' : '▸'}
                      </span>
                      {nameFor(row.contenderId)}
                    </button>
                  ) : (
                    <span className="arena-tour__name-plain">{nameFor(row.contenderId)}</span>
                  )}
                </th>
                <td className="arena-tour__points">{row.points}</td>
                <td>{row.wins}</td>
                <td>{row.losses}</td>
                <td>{row.tournaments}</td>
                <td>{row.titles}</td>
              </tr>
              {open ? (
                <tr className="arena-tour__breakdownrow">
                  <td />
                  <td colSpan={6}>
                    <ul className="arena-tour__breakdown">
                      {breakdown.map((entry) => (
                        <li key={entry.tournamentId}>
                          <span>
                            {nameOfTournament.get(entry.tournamentId) ?? entry.tournamentId}
                          </span>
                          <span>
                            {entry.wins} {entry.wins === 1 ? 'win' : 'wins'} · {entry.points} pts
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
