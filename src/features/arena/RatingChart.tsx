/**
 * Ratings over time — the part of the leaderboard you actually watch.
 *
 * The table answers "who is ahead". This answers the question that made the benchmark worth
 * running: *when* did that happen, and is it still happening? A model that climbed steadily
 * over forty rounds and one that got lucky twice look identical in a snapshot.
 *
 * Every value here comes from the same replay that produced the table, so the last point on
 * a line is the number in its row by construction — there is no second calculation that
 * could disagree.
 *
 * Under the plot is the axis made legible: one tick per round, coloured by what you decided.
 * It is the only place the shape of a sitting is visible — a run of one-sided verdicts, a
 * patch of ties, the round where you rejected both — and because every round stores the full
 * text of both replies, a tick can open the round it stands for.
 *
 * The legend is a focus filter: with eight lines in one plot, picking two or three is often
 * the only way to read any of them. Picking narrows the drawn lines AND the y-axis to the
 * selection — the shape of the picked climb is the point — while the x-axis keeps counting
 * every round, since every series covers every one. A line's colour is the full view's and
 * never changes through a focus, so the eye keeps its bearings.
 */

import type { ArenaRound } from '@shared/types/arena.ts';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useState } from 'react';
import { indexAt, plotLine, plotX, plotY, ratingBounds, visibleSeries } from './chart.ts';
import type { LeaderboardRow, RatingSeries } from './elo.ts';
import { START_RATING } from './elo.ts';
import { colourOf } from './series.ts';

/**
 * The drawing surface, in viewBox units.
 *
 * Scaled UNIFORMLY to the container by CSS (`width: 100%; height: auto`), never stretched.
 * Stretching would fill the width more neatly and turn every dot into an ellipse — and,
 * worse, would change the apparent steepness of a climb with the width of the window, which
 * on a chart about how fast a rating moved is the one distortion that actually misleads.
 */
const WIDTH = 720;
const HEIGHT = 200;

interface RatingChartProps {
  series: readonly RatingSeries[];
  rows: readonly LeaderboardRow[];
  /** The rounds behind the axis, oldest first — the same order the series were built in. */
  ordered: readonly ArenaRound[];
  /** Corner colours, resolved for this view. */
  colours: ReadonlyMap<string, string>;
  /** Resolves a contender id to what the user calls it. */
  nameOf: (contenderId: string, model: string) => string;
  /** Open the round a tick stands for. */
  onOpenRound: (round: ArenaRound) => void;
}

export function RatingChart({
  series,
  rows,
  ordered,
  colours,
  nameOf,
  onOpenRound,
}: RatingChartProps) {
  const [active, setActive] = useState<number | null>(null);
  /** Contender ids the legend has picked. Empty means the whole board is drawn. */
  const [focus, setFocus] = useState<ReadonlySet<string>>(new Set());

  const toggleFocus = (contenderId: string) => {
    setFocus((prev) => {
      const next = new Set(prev);
      if (next.has(contenderId)) next.delete(contenderId);
      else next.add(contenderId);
      return next;
    });
  };

  const count = series[0]?.points.length ?? 0;
  const visible = visibleSeries(series, focus);
  const focused = focus.size > 0 && visible.length < series.length;
  const bounds = ratingBounds(visible);
  const startY = plotY(START_RATING, bounds, HEIGHT);

  const onMove = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      if (box.width === 0) return;
      setActive(indexAt((event.clientX - box.left) / box.width, count));
    },
    [count],
  );

  // One round is a single dot with nothing to join; the table already says everything.
  if (count < 2) return null;

  const reading = active ?? count - 1;
  const focusNote = focused
    ? `, focused on ${visible.map((entry) => nameOf(entry.contenderId, entry.model)).join(', ')}`
    : '';

  return (
    <figure className="rating-chart">
      <figcaption className="rating-chart__caption">
        <span className="rating-chart__title">
          Rating over {count - 1} {count - 1 === 1 ? 'round' : 'rounds'}
        </span>
        {focus.size > 0 ? (
          <button type="button" className="rating-chart__clear" onClick={() => setFocus(new Set())}>
            Show all
          </button>
        ) : null}
        <span className="rating-chart__reading">
          {active !== null
            ? `After round ${reading}`
            : focus.size > 0
              ? `Showing ${visible.length} of ${series.length} · hover to read a round`
              : 'Hover to read a round · click a tick to open it · click a name to focus'}
        </span>
      </figcaption>

      {/*
       * The hover readout is an enhancement, never the only way in: every line's final
       * rating is in the legend and again in the table below, so nothing here is reachable
       * by pointer alone. Same trade the Stats charts make, for the same reason.
       */}
      <svg
        className="rating-chart__plot"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Rating over ${count - 1} rounds${focusNote}`}
        onMouseMove={onMove}
        onMouseLeave={() => setActive(null)}
      >
        <title>{`Rating over ${count - 1} rounds${focusNote}`}</title>

        {/* Where everyone started. The only reference line worth drawing: every rating on
            the chart is a distance from it. */}
        <line
          className="rating-chart__baseline"
          x1={0}
          y1={startY}
          x2={WIDTH}
          y2={startY}
          vectorEffect="non-scaling-stroke"
        />

        {active !== null ? (
          <line
            className="rating-chart__crosshair"
            x1={plotX(reading, count, WIDTH)}
            y1={0}
            x2={plotX(reading, count, WIDTH)}
            y2={HEIGHT}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {visible.map((entry, index) => (
          <g
            key={entry.contenderId}
            style={{ '--wc-series': colourOf(colours, entry.contenderId) } as CSSProperties}
          >
            <polyline
              className="rating-chart__line"
              points={plotLine(entry.points, bounds, WIDTH, HEIGHT)}
              // Without this a wide viewBox scaled into a narrow container would thin the
              // stroke to nothing, and a tall one would fatten it into a slab.
              vectorEffect="non-scaling-stroke"
              style={{ '--i': index } as CSSProperties}
            />
            <circle
              className="rating-chart__dot"
              cx={plotX(reading, count, WIDTH)}
              cy={plotY(entry.points[reading]?.rating ?? START_RATING, bounds, HEIGHT)}
              r={3}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </svg>

      {/*
       * One tick per round. Buttons rather than decoration, because each one opens something
       * — and a keyboard user gets the same access to the history as a pointer does.
       */}
      <ol className="rating-scrub" aria-label="Every recorded round, by verdict">
        {ordered.map((round, index) => (
          <li key={round.id} className="rating-scrub__slot">
            <button
              type="button"
              className="rating-scrub__tick"
              data-verdict={round.verdict}
              data-current={reading === index + 1}
              onMouseEnter={() => setActive(index + 1)}
              onFocus={() => setActive(index + 1)}
              onClick={() => onOpenRound(round)}
              title={`Round ${index + 1} — ${verdictWord(round.verdict)}. Open it.`}
            >
              <span className="wc-visually-hidden">
                Round {index + 1}, {verdictWord(round.verdict)}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/* Every model stays listed however narrow the focus gets — the way back in is the
          same one click as the way out. */}
      <ul className="rating-chart__legend">
        {series.map((entry) => {
          const point = entry.points[reading];
          const row = rows.find((item) => item.contenderId === entry.contenderId);
          const on = focus.size === 0 || focus.has(entry.contenderId);
          const title = !on
            ? 'Click to draw this model'
            : focus.size > 0
              ? 'Click to remove this model from the focus'
              : 'Click to focus the chart on this model';
          return (
            <li
              key={entry.contenderId}
              className="rating-chart__key"
              style={{ '--wc-series': colourOf(colours, entry.contenderId) } as CSSProperties}
            >
              <button
                type="button"
                className="rating-chart__keybtn"
                data-on={on}
                aria-pressed={on}
                title={title}
                onClick={() => toggleFocus(entry.contenderId)}
              >
                <span className="rating-chart__swatch" aria-hidden="true" />
                <span className="rating-chart__name">{nameOf(entry.contenderId, entry.model)}</span>
                <span className="rating-chart__value">{point?.rating ?? START_RATING}</span>
                {/* The swing this round, which is the whole story of a single row: winning as
                    a favourite earns little, losing as one costs a lot. */}
                <span className="rating-chart__delta" data-sign={signOf(point?.delta ?? 0)}>
                  {formatDelta(point?.delta ?? 0)}
                </span>
                {row?.provisional ? (
                  <span className="rating-chart__provisional" title="Provisional — see the table">
                    ?
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

function verdictWord(verdict: ArenaRound['verdict']): string {
  if (verdict === 'left') return 'A won';
  if (verdict === 'right') return 'B won';
  if (verdict === 'tie') return 'a tie';
  return 'both rejected';
}

function signOf(delta: number): 'up' | 'down' | 'flat' {
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'flat';
}

function formatDelta(delta: number): string {
  if (delta === 0) return '—';
  return delta > 0 ? `+${delta}` : String(delta);
}
