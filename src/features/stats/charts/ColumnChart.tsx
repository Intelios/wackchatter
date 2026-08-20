import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { DayBucket } from '../buckets.ts';
import { count, dayLabel, fullDayLabel } from '../format.ts';
import { columnHeights } from '../geometry.ts';

interface ColumnChartProps {
  days: readonly DayBucket[];
  emptyMessage?: string;
}

const PLOT_HEIGHT = 100;

/**
 * Messages per day, on a real time axis.
 *
 * Empty days are drawn as gaps rather than skipped, because a fortnight off is part of the
 * shape. Columns rise on mount left to right, which is also the direction the axis reads.
 */
export function ColumnChart({ days, emptyMessage = 'No activity yet.' }: ColumnChartProps) {
  const [active, setActive] = useState<number | null>(null);

  if (days.length === 0) return <p className="wc-empty">{emptyMessage}</p>;

  const heights = columnHeights(
    days.map((day) => day.count),
    PLOT_HEIGHT,
  );
  const busiest = days.reduce((best, day) => Math.max(best, day.count), 0);
  const reading = active === null ? null : days[active];

  return (
    <div className="columns">
      <div className="columns__readout">
        {reading ? (
          <>
            <strong>{count(reading.count)}</strong>
            <span>{fullDayLabel(reading.day)}</span>
          </>
        ) : (
          <>
            <strong>{count(busiest)}</strong>
            <span>busiest day</span>
          </>
        )}
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: The hover readout is an enhancement, not the only path in: every column, slice and spoke already carries its figure as text for assistive tech. Making them focusable would add dozens of tab stops to reach what is announced anyway. */}
      <div className="columns__plot" onMouseLeave={() => setActive(null)}>
        {days.map((day, index) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: hover-only readout, see above
          <div
            key={day.day}
            className="columns__column"
            data-active={active === index || undefined}
            data-empty={day.count === 0 || undefined}
            style={{ '--i': index, '--h': `${heights[index] ?? 0}%` } as CSSProperties}
            onMouseEnter={() => setActive(index)}
          >
            <span className="columns__bar" />
            {/* Native title, so the figure is reachable without the pointer trick. */}
            <span className="wc-visually-hidden">{`${fullDayLabel(day.day)}: ${count(day.count)}`}</span>
          </div>
        ))}
      </div>

      <div className="columns__axis">
        <span>{dayLabel(days[0]!.day)}</span>
        <span>{dayLabel(days[days.length - 1]!.day)}</span>
      </div>
    </div>
  );
}
