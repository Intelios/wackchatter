import type { CSSProperties } from 'react';

export interface BarRow {
  id: string;
  label: string;
  value: number;
  /** Right-hand figure. Defaults to the value itself. */
  display?: string;
  hint?: string;
  avatarUrl?: string;
  /** Series index, so a row keeps its colour across charts. */
  series?: number;
}

interface BarRowsProps {
  rows: readonly BarRow[];
  onSelect?: (id: string) => void;
  emptyMessage?: string;
}

/**
 * A ranked list where the bar is the comparison and the number is the detail.
 *
 * Bars grow from the left on mount, staggered down the list, so the ranking assembles in
 * the order it should be read. Scale is against the largest row rather than the total: the
 * question a leaderboard answers is "how does this compare to the top", not "what share of
 * everything is it" — that is what the donut is for.
 */
export function BarRows({ rows, onSelect, emptyMessage = 'Nothing yet.' }: BarRowsProps) {
  if (rows.length === 0) return <p className="wc-empty">{emptyMessage}</p>;

  const max = rows.reduce((best, row) => Math.max(best, row.value), 0);

  return (
    <ul className="bar-rows">
      {rows.map((row, index) => {
        const share = max > 0 ? row.value / max : 0;
        const style = {
          '--i': index,
          '--share': share,
          '--wc-series': `var(--wc-series-${((row.series ?? index) % 8) + 1})`,
        } as CSSProperties;

        const body = (
          <>
            {row.avatarUrl ? (
              <img className="bar-rows__avatar" src={row.avatarUrl} alt="" />
            ) : (
              <span className="bar-rows__swatch" aria-hidden="true" />
            )}
            <span className="bar-rows__label" title={row.label}>
              {row.label}
            </span>
            <span className="bar-rows__track">
              <span className="bar-rows__fill" />
            </span>
            <span className="bar-rows__value">{row.display ?? row.value}</span>
          </>
        );

        return (
          <li key={row.id} className="bar-rows__row" style={style} title={row.hint}>
            {onSelect ? (
              <button type="button" className="bar-rows__open" onClick={() => onSelect(row.id)}>
                {body}
              </button>
            ) : (
              <div className="bar-rows__static">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
