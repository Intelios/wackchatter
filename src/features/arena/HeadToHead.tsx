/**
 * Who actually beat whom.
 *
 * The single most informative view a pairwise benchmark can produce, and it needs nothing
 * the rounds did not already store — see matchups.ts. A rating is a summary and summaries
 * hide things: two contenders twenty points apart may never have met, and the matrix is the
 * only place that is visible.
 *
 * A real `<table>`, not a grid of divs. The headers are what make a cell mean anything —
 * "67%" alone is not a fact — and a screen reader announcing "gemma4, row, versus gpt-oss,
 * column, 67%" is the same sentence a sighted reader assembles from the axes.
 *
 * The fill is a diverging scale around 50%, and it is never the only carrier: every cell
 * prints its rate and its record, so the colour is a way to find the interesting corner of
 * the grid rather than the way to read it.
 */

import type { CSSProperties } from 'react';
import type { LeaderboardRow } from './elo.ts';
import type { MatchupTable } from './matchups.ts';
import { matchupOf, winRate } from './matchups.ts';
import { colourOf } from './series.ts';

interface HeadToHeadProps {
  rows: readonly LeaderboardRow[];
  table: MatchupTable;
  colours: ReadonlyMap<string, string>;
  nameOf: (contenderId: string, model: string) => string;
}

/**
 * How far from even a rate has to be before it is worth colouring at all.
 *
 * Two rounds out of three is 67%, which on three rounds is one round of luck. Tinting it as
 * strongly as nine wins out of ten would make the grid shout loudest exactly where it knows
 * least, so the fill is scaled by both the margin AND the number of rounds behind it.
 */
const CONFIDENT_ROUNDS = 6;

function fill(rate: number | null, played: number): string | undefined {
  if (rate === null) return undefined;
  const margin = (rate - 0.5) * 2; // -1 … 1
  if (margin === 0) return undefined;
  const confidence = Math.min(1, played / CONFIDENT_ROUNDS);
  const alpha = Math.min(0.34, Math.abs(margin) * confidence * 0.34);
  return margin > 0
    ? `color-mix(in srgb, var(--wc-success) ${Math.round(alpha * 100)}%, transparent)`
    : `color-mix(in srgb, var(--wc-danger) ${Math.round(alpha * 100)}%, transparent)`;
}

export function HeadToHead({ rows, table, colours, nameOf }: HeadToHeadProps) {
  // Two entrants have exactly one pairing, which the record on each row already states.
  if (rows.length < 3) return null;

  return (
    <section className="arena-h2h">
      <header className="arena-h2h__head">
        <h3>Head to head</h3>
        <p className="wc-hint">
          Each row&rsquo;s win rate against each column, counting a tie as half. A tie lifts both
          ratings a little rather than splitting a point; least-played pairing keeps this filling in
          evenly rather than re-deciding the matchups you have already settled.
        </p>
      </header>

      <div className="arena-h2h__scroll">
        <table className="arena-h2h__table">
          <thead>
            <tr>
              <th scope="col">
                <span className="wc-visually-hidden">Contender</span>
              </th>
              {rows.map((column) => (
                <th key={column.contenderId} scope="col" className="arena-h2h__column">
                  <span title={nameOf(column.contenderId, column.model)}>
                    {nameOf(column.contenderId, column.model)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.contenderId}>
                <th
                  scope="row"
                  className="arena-h2h__row"
                  style={{ '--wc-corner': colourOf(colours, row.contenderId) } as CSSProperties}
                >
                  <span className="arena-h2h__swatch" aria-hidden="true" />
                  <span className="arena-h2h__name">{nameOf(row.contenderId, row.model)}</span>
                </th>

                {rows.map((column) => {
                  if (column.contenderId === row.contenderId) {
                    return (
                      <td key={column.contenderId} className="arena-h2h__cell" data-self="true">
                        <span aria-hidden="true">—</span>
                        <span className="wc-visually-hidden">itself</span>
                      </td>
                    );
                  }

                  const matchup = matchupOf(table, row.contenderId, column.contenderId);
                  const rate = winRate(matchup);

                  if (rate === null) {
                    return (
                      <td key={column.contenderId} className="arena-h2h__cell" data-none="true">
                        {matchup.rejected > 0 ? 'both rejected' : 'not yet'}
                      </td>
                    );
                  }

                  return (
                    <td
                      key={column.contenderId}
                      className="arena-h2h__cell"
                      style={{ background: fill(rate, matchup.played) }}
                      title={`${matchup.wins}W ${matchup.losses}L ${matchup.ties}T over ${matchup.played} rounds`}
                    >
                      <span className="arena-h2h__rate">{Math.round(rate * 100)}%</span>
                      <span className="arena-h2h__record">
                        {matchup.wins}&ndash;{matchup.losses}
                        {matchup.ties > 0 ? `–${matchup.ties}` : ''}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
