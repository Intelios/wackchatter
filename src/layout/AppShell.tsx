import type { ReactNode } from 'react';
import { SlidersIcon, UsersIcon } from './icons.tsx';
import './AppShell.css';

interface PanelToggleProps {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}

export function PanelToggle({ open, onToggle, label, children }: PanelToggleProps) {
  return (
    <button
      type="button"
      className="panel-toggle"
      aria-pressed={open}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}

interface AppShellProps {
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  left: ReactNode;
  right: ReactNode;
  title: ReactNode;
  children: ReactNode;
}

/**
 * The three-column layout. Panels compress the chat column rather than covering it,
 * so the conversation stays visible and usable while settings or the character editor
 * are open.
 */
export function AppShell({
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  left,
  right,
  title,
  children,
}: AppShellProps) {
  return (
    <div className="shell" data-left-open={leftOpen} data-right-open={rightOpen}>
      {/* aria-hidden when closed so collapsed panels leave the tab order entirely. */}
      <aside className="panel panel--left" aria-hidden={!leftOpen} inert={!leftOpen || undefined}>
        <div className="panel__inner">{left}</div>
      </aside>

      <main className="chat-column">
        <div className="chat-column__bar">
          <PanelToggle open={leftOpen} onToggle={onToggleLeft} label="Toggle settings panel">
            <SlidersIcon />
          </PanelToggle>

          <div className="chat-column__title">{title}</div>

          <PanelToggle open={rightOpen} onToggle={onToggleRight} label="Toggle character panel">
            <UsersIcon />
          </PanelToggle>
        </div>

        <div className="chat-column__body">{children}</div>
      </main>

      <aside
        className="panel panel--right"
        aria-hidden={!rightOpen}
        inert={!rightOpen || undefined}
      >
        <div className="panel__inner">{right}</div>
      </aside>
    </div>
  );
}

interface PanelProps {
  title: string;
  actions?: ReactNode;
  /** A tab strip under the header. Sits outside the body, so it never scrolls away. */
  tabs?: ReactNode;
  children: ReactNode;
}

/** Standard panel chrome: a fixed header and a single scrolling body. */
export function Panel({ title, actions, tabs, children }: PanelProps) {
  return (
    <>
      <header className="panel__header">
        <span className="panel__title">{title}</span>
        {actions ? (
          <div style={{ display: 'flex', gap: 'var(--wc-space-1)' }}>{actions}</div>
        ) : null}
      </header>
      {tabs}
      <div className="panel__body">{children}</div>
    </>
  );
}
