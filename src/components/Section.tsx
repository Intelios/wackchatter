import { type ReactNode, useId, useState } from 'react';
import { ChevronIcon } from '../layout/icons.tsx';
import './Section.css';

interface SectionProps {
  title: string;
  /** Short summary shown on the header when collapsed, e.g. a count. */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A collapsible section. The card editor has far more fields than fit on one screen,
 * so grouping them this way keeps the panel navigable without resorting to a modal.
 */
export function Section({ title, badge, defaultOpen = false, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <section className="section" data-open={open}>
      <button
        type="button"
        className="section__header"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon className="section__chevron" />
        <span className="section__title">{title}</span>
        {badge != null ? <span className="section__badge">{badge}</span> : null}
      </button>

      {/* Unmounted when closed — a card can hold a large lorebook and we don't want
          hundreds of hidden inputs in the tree. */}
      {open ? (
        <div className="section__content" id={contentId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
