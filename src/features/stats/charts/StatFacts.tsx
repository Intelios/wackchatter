import type { ReactNode } from 'react';

export interface StatFact {
  label: string;
  value: ReactNode;
  hint?: string;
}

/**
 * The small print of a section: label left, figure right.
 *
 * Same shape as the Studio inspector's breakdown, because it answers the same kind of
 * question — the detail behind a headline you have already read.
 */
export function StatFacts({ facts }: { facts: readonly StatFact[] }) {
  return (
    <dl className="stat-facts">
      {facts.map((fact) => (
        <div key={fact.label} title={fact.hint}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
