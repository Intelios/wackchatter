import type { CSSProperties, ReactNode } from 'react';

interface StatSectionProps {
  eyebrow: string;
  title: string;
  hint?: string;
  /** Position in the page, for the staggered entrance. */
  index?: number;
  /** Two columns on a wide canvas, for a chart that needs the room beside its legend. */
  split?: boolean;
  children: ReactNode;
}

/** One band of the stats page. The eyebrow/heading pair matches the Studio and Co-Creator. */
export function StatSection({
  eyebrow,
  title,
  hint,
  index = 0,
  split,
  children,
}: StatSectionProps) {
  return (
    <section
      className="stats-section"
      data-split={split || undefined}
      style={{ '--i': index } as CSSProperties}
    >
      <header className="stats-section__head">
        <p className="stats-section__eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {hint ? <p className="wc-hint">{hint}</p> : null}
      </header>
      <div className="stats-section__body">{children}</div>
    </section>
  );
}
