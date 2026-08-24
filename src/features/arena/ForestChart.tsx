/**
 * The board's default graph: every contender's rating as a point, with the band the same
 * evidence could have put it in — the forest plot LMSYS's leaderboard made familiar.
 *
 * The trend chart answers "when did that happen". This answers the question a growing
 * roster actually asks: who is ahead, and by enough to mean anything? A row per contender
 * reads at any pool size — a model that joined at round eighty is a row with an honestly
 * wide band, not a line that spends eighty rounds flat at the start — and overlapping bands
 * say "these two are not settled apart", which a column of point ratings cannot.
 *
 * The dot is the number in the table row by construction: both come from the same `replay`
 * the rest of the board reads, and the whisker is `ratingIntervals`' bootstrap over the
 * same rounds. Nothing is clamped — a tiny history can leave the point at the very end of
 * its band, and drawing that is the honest picture.
 *
 * Rows are HTML on a shared percentage axis (the table's bar column uses the same trick),
 * not one big SVG: names ellipsize, every value stays real text, and the whiskers of all
 * rows still read against one scale because `forestBounds` is computed once for the board.
 */

import type { ArenaRound } from '@shared/types/arena.ts';
import type { CSSProperties, ReactNode } from 'react';
import type { LeaderboardRow } from './elo.ts';
import { PROVISIONAL_ROUNDS, START_RATING } from './elo.ts';
import { forestBounds, forestPercent } from './forest.ts';
import type { RatingInterval } from './intervals.ts';
import { RatingScrub } from './RatingScrub.tsx';
import { colourOf } from './series.ts';

interface ForestChartProps {
  rows: readonly LeaderboardRow[];
  /** Bootstrap bands, keyed like `colours` — a contender with no entry has not been measured. */
  intervals: ReadonlyMap<string, RatingInterval>;
  /** The rounds behind the scrub strip, oldest first. */
  ordered: readonly ArenaRound[];
  /** Corner colours, resolved for this view. */
  colours: ReadonlyMap<string, string>;
  /** Resolves a contender id to what the user calls it. */
  nameOf: (contenderId: string, model: string) => string;
  /** Open the round a tick stands for. */
  onOpenRound: (round: ArenaRound) => void;
  /** The view toggle, rendered between the title and the reading. */
  action?: ReactNode;
}

export function ForestChart({
  rows,
  intervals,
  ordered,
  colours,
  nameOf,
  onOpenRound,
  action,
}: ForestChartProps) {
  const bounds = forestBounds(rows, intervals);
  const zero = forestPercent(START_RATING, bounds);
  const rated = ordered.filter((round) => round.verdict !== 'bad').length;

  // Nothing measured, nothing to draw — the table below still lists the pool.
  if (intervals.size === 0) return null;

  return (
    <figure className="forest">
      <figcaption className="forest__caption">
        <span className="forest__title">
          {rated} rated {rated === 1 ? 'round' : 'rounds'}, banded by bootstrap
        </span>
        {action}
        <span className="forest__reading">
          The dot is the replayed rating · the whisker is where the same rounds could have put it ·
          overlapping whiskers are not settled apart
        </span>
      </figcaption>

      {/*
       * The 1500 guide is drawn per row (one shared axis column across stacked rows), set
       * from a single --wc-forest-zero so every segment lands at the same percentage. Every
       * value in the plot — name, band bounds, rating — is real text: the geometry is the
       * enhancement, never the only way in.
       */}
      <ol className="forest__rows" style={{ '--wc-forest-zero': `${zero}%` } as CSSProperties}>
        {rows.map((row, index) => {
          const interval = intervals.get(row.contenderId);
          const name = nameOf(row.contenderId, row.model);
          return (
            <li
              key={row.contenderId}
              className="forest__row"
              data-provisional={row.provisional}
              style={
                {
                  '--wc-series': colourOf(colours, row.contenderId),
                  '--i': index,
                } as CSSProperties
              }
            >
              <span className="forest__rank">{index + 1}</span>
              <span className="forest__name" title={name}>
                {name}
              </span>
              <span className="forest__track">
                <i className="forest__guide" aria-hidden="true" />
                {interval ? (
                  <i
                    className="forest__whisker"
                    aria-hidden="true"
                    style={{
                      left: `${forestPercent(interval.low, bounds)}%`,
                      width: `${forestPercent(interval.high, bounds) - forestPercent(interval.low, bounds)}%`,
                    }}
                  />
                ) : null}
                {interval ? (
                  <i
                    className="forest__dot"
                    aria-hidden="true"
                    style={{ left: `${forestPercent(row.rating, bounds)}%` }}
                  />
                ) : null}
              </span>
              <span className="forest__range">
                {interval ? `${interval.low} – ${interval.high}` : 'not measured'}
              </span>
              <span className="forest__rating">
                {row.rating}
                {row.provisional ? (
                  <span
                    className="rating-chart__provisional"
                    title={`Provisional — fewer than ${PROVISIONAL_ROUNDS} rated rounds. Treat it as noise until it settles.`}
                  >
                    ?
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      <RatingScrub ordered={ordered} onOpenRound={onOpenRound} />
    </figure>
  );
}
