import type { CSSProperties, ReactNode } from 'react';
import { useCountUp } from './useCountUp.ts';

interface StatTileProps {
  label: string;
  value: number;
  /** How the counted value reads. Runs on every frame, so keep it cheap. */
  format: (value: number) => string;
  hint?: ReactNode;
  /** The one number a section is really about. Larger, and it catches the light. */
  hero?: boolean;
  index?: number;
}

/**
 * A counted number under a label.
 *
 * The count-up is the point: a figure that arrives at its value tells you it was measured,
 * where the same figure printed flat is just furniture.
 */
export function StatTile({ label, value, format, hint, hero, index = 0 }: StatTileProps) {
  const counted = useCountUp(value, hero ? 1100 : 800, index * 55);

  return (
    <div
      className="stat-tile"
      data-hero={hero || undefined}
      style={{ '--i': index } as CSSProperties}
    >
      <span className="stat-tile__label">{label}</span>
      <strong className="stat-tile__value">{format(counted)}</strong>
      {hint ? <span className="stat-tile__hint">{hint}</span> : null}
    </div>
  );
}
