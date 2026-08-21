import type { CSSProperties } from 'react';
import { useState } from 'react';
import { donutSegments } from '../geometry.ts';

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
  /** The line under the centre figure while this slice is the one being read. */
  detail?: string;
}

interface DonutProps {
  slices: readonly DonutSlice[];
  /** Centre figure when nothing is hovered. */
  totalLabel: string;
  totalHint: string;
  emptyMessage?: string;
}

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Shares of a whole, with the readout in the hole.
 *
 * Hovering a slice swaps the centre rather than opening a tooltip: the app has no tooltip
 * component and no toast system on purpose, and a figure that changes in place is easier to
 * compare against the last one you looked at than a box that follows the cursor.
 */
export function Donut({
  slices,
  totalLabel,
  totalHint,
  emptyMessage = 'Nothing yet.',
}: DonutProps) {
  const [active, setActive] = useState<number | null>(null);

  if (slices.length === 0) return <p className="wc-empty">{emptyMessage}</p>;

  const segments = donutSegments(
    slices.map((slice) => slice.value),
    CIRCUMFERENCE,
  );
  const reading = active === null ? null : slices[active];
  const share = active === null ? null : (segments[active]?.share ?? null);

  return (
    <div className="donut">
      <div className="donut__ring">
        <svg viewBox="0 0 100 100" role="img" aria-label={`${totalLabel} by share`}>
          <circle className="donut__track" cx="50" cy="50" r={RADIUS} />
          {segments.map((segment, index) => {
            const slice = slices[index];
            if (!slice) return null;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: The hover readout is an enhancement, not the only path in: every column, slice and spoke already carries its figure as text for assistive tech. Making them focusable would add dozens of tab stops to reach what is announced anyway.
              <circle
                key={slice.id}
                className="donut__segment"
                cx="50"
                cy="50"
                r={RADIUS}
                data-active={active === index || undefined}
                data-dimmed={(active !== null && active !== index) || undefined}
                style={
                  {
                    '--i': index,
                    '--dash': segment.dash,
                    '--gap': segment.gap,
                    '--offset': segment.offset,
                    '--wc-series': `var(--wc-series-${(index % 8) + 1})`,
                  } as CSSProperties
                }
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
              >
                <title>{`${slice.label}: ${Math.round(segment.share * 100)}%`}</title>
              </circle>
            );
          })}
        </svg>
        <div className="donut__centre" aria-hidden="true">
          <strong>{reading && share !== null ? `${Math.round(share * 100)}%` : totalLabel}</strong>
          <span>{reading ? reading.label : totalHint}</span>
        </div>
      </div>

      <ul className="donut__legend">
        {slices.map((slice, index) => (
          <li
            key={slice.id}
            data-active={active === index || undefined}
            style={
              {
                '--i': index,
                '--wc-series': `var(--wc-series-${(index % 8) + 1})`,
              } as CSSProperties
            }
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
          >
            <span className="donut__swatch" aria-hidden="true" />
            <span className="donut__name" title={slice.label}>
              {slice.label}
            </span>
            <span className="donut__detail">{slice.detail ?? slice.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
