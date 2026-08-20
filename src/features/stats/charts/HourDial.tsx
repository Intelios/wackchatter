import type { CSSProperties } from 'react';
import { useState } from 'react';
import { count, hourLabel } from '../format.ts';
import { spoke } from '../geometry.ts';

interface HourDialProps {
  /** 24 counts, indexed by local hour. */
  hours: readonly number[];
}

/*
 * Geometry in viewBox units. The box is padded past 120 so the quarter-hour labels have
 * somewhere to sit, and the ring is sized against that padded width — otherwise the dial
 * shrinks into the middle and the numbers drift off on their own.
 */
const CENTRE = 60;
const INNER = 24;
const OUTER = 58;
const TICK = OUTER + 5;

/**
 * When you actually play, as a clock face.
 *
 * A bar chart of 24 hours reads as a mountain with a cliff at midnight; a dial puts 23:00
 * next to 00:00 where it belongs, so a session that runs past midnight looks continuous
 * instead of wrapping. Every hour keeps a tick at the inner radius, so the face stays
 * readable as a clock even where nothing happened.
 */
export function HourDial({ hours }: HourDialProps) {
  const [active, setActive] = useState<number | null>(null);

  const max = hours.reduce((best, value) => Math.max(best, value), 0);
  const peak = hours.reduce((best, value, index) => (value > (hours[best] ?? 0) ? index : best), 0);
  const reading = active === null ? peak : active;

  if (max === 0) return <p className="wc-empty">No activity yet.</p>;

  return (
    <div className="dial">
      {/* Padded viewBox rather than overflow: the quarter-hour labels sit outside the
          spokes, and without room for them they hang off the edge of the dial. */}
      <svg viewBox="-6 -6 132 132" role="img" aria-label="Messages by hour of day">
        <circle className="dial__ring" cx={CENTRE} cy={CENTRE} r={INNER} />
        {hours.map((value, index) => {
          const line = spoke(CENTRE, CENTRE, INNER + 2, OUTER, index, value, max);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: The hover readout is an enhancement, not the only path in: every column, slice and spoke already carries its figure as text for assistive tech. Making them focusable would add dozens of tab stops to reach what is announced anyway.
            <line
              key={hourLabel(index)}
              className="dial__spoke"
              // Normalises every spoke to length 1, so one dash-offset keyframe draws
              // them all regardless of how long each actually is.
              pathLength={1}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              data-active={reading === index || undefined}
              style={{ '--i': index } as CSSProperties}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
            >
              <title>{`${hourLabel(index)}: ${count(value)}`}</title>
            </line>
          );
        })}
        {/* Quarter marks, so the ring can be read as a clock rather than a ring. */}
        {[0, 6, 12, 18].map((hour) => (
          <text
            key={hour}
            className="dial__tick"
            x={CENTRE + Math.cos((hour / 24) * Math.PI * 2 - Math.PI / 2) * TICK}
            y={CENTRE + Math.sin((hour / 24) * Math.PI * 2 - Math.PI / 2) * TICK}
          >
            {hour}
          </text>
        ))}
      </svg>
      <div className="dial__centre" aria-hidden="true">
        <strong>{hourLabel(reading)}</strong>
        <span>{count(hours[reading] ?? 0)}</span>
      </div>
    </div>
  );
}
