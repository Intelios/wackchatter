import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { PanelSpec } from './panels.tsx';
import './AppShell.css';

interface PanelClusterProps<T extends string> {
  buttons: readonly PanelSpec<T>[];
  active: T | null;
  onSelect: (id: T) => void;
  side: 'left' | 'right';
}

/** Where the sliding highlight sits, relative to the cluster. */
interface IndicatorRect {
  x: number;
  width: number;
}

/**
 * A side's button group.
 *
 * These are toggle buttons, not tabs: `role="tab"` would promise arrow-key navigation
 * between siblings, and these panels are not siblings under one container. `aria-pressed`
 * says "this is on", `aria-expanded` + `aria-controls` say "and it revealed that".
 *
 * The active state is one pill per cluster, measured to sit behind the active button and
 * moved with transform/width transitions — so hopping from Generation to Inspect slides
 * the highlight across the gap instead of two independent buttons toggling fills. The
 * pill keeps its last position when the panel closes and just fades.
 */
function PanelCluster<T extends string>({ buttons, active, onSelect, side }: PanelClusterProps<T>) {
  const clusterRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const readyRef = useRef(false);
  const [rect, setRect] = useState<IndicatorRect | null>(null);
  const [ready, setReady] = useState(false);

  /*
   * Layout effect, not effect: the pill must be at its final position for the very first
   * paint, or a no-transition frame shows it at width 0 before the position lands.
   */
  useLayoutEffect(() => {
    const button = active ? buttonRefs.current.get(active) : undefined;
    if (!button) return;
    setRect({ x: button.offsetLeft, width: button.offsetWidth });
    if (!readyRef.current) {
      readyRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    }
  }, [active]);

  /*
   * Button widths are not fixed: the <=1100px query drops the labels, and loading fonts
   * shift text widths. Either changes the cluster's size, so observing the cluster
   * catches both. The offset reads are stable inside the callback — layout is current
   * when ResizeObserver callbacks run.
   */
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster) return;
    const observer = new ResizeObserver(() => {
      const button = active ? buttonRefs.current.get(active) : undefined;
      if (!button) return;
      setRect({ x: button.offsetLeft, width: button.offsetWidth });
    });
    observer.observe(cluster);
    return () => observer.disconnect();
  }, [active]);

  return (
    <div ref={clusterRef} className={`shell__cluster shell__cluster--${side}`}>
      {rect ? (
        <span
          aria-hidden="true"
          className="shell__cluster-indicator"
          data-active={active !== null}
          data-ready={ready}
          style={{ transform: `translateX(${rect.x}px)`, width: rect.width }}
        />
      ) : null}
      {buttons.map((button) => (
        <button
          key={button.id}
          ref={(el) => {
            if (el) buttonRefs.current.set(button.id, el);
            else buttonRefs.current.delete(button.id);
          }}
          type="button"
          className="panel-toggle"
          aria-pressed={active === button.id}
          aria-expanded={active === button.id}
          aria-controls={`panel-${side}`}
          title={button.label}
          onClick={() => onSelect(button.id)}
        >
          {button.icon}
          <span className="panel-toggle__label">{button.label}</span>
        </button>
      ))}
    </div>
  );
}

interface AppShellProps<L extends string, R extends string> {
  leftPanel: L | null;
  rightPanel: R | null;
  leftButtons: readonly PanelSpec<L>[];
  rightButtons: readonly PanelSpec<R>[];
  onSelectLeft: (id: L) => void;
  onSelectRight: (id: R) => void;
  left: ReactNode;
  right: ReactNode;
  title: ReactNode;
  children: ReactNode;
  /** Already resolved. Null renders the flat background and disables glass entirely. */
  backgroundUrl?: string | null;
  backgroundBlur?: number;
  backgroundDim?: number;
  glass?: boolean;
}

/**
 * A full-width header row over three columns.
 *
 * Panels compress the chat rather than covering it, so the conversation stays visible and
 * usable while settings or the character editor are open. The bar spans every column
 * (`grid-column: 1 / -1`), which is what keeps the button clusters pinned to the screen
 * edges: the bar's own width never changes as the columns animate, so its children never
 * move. Buttons you can find without looking are the whole point of putting them there.
 */
export function AppShell<L extends string, R extends string>({
  leftPanel,
  rightPanel,
  leftButtons,
  rightButtons,
  onSelectLeft,
  onSelectRight,
  left,
  right,
  title,
  children,
  backgroundUrl = null,
  backgroundBlur = 8,
  backgroundDim = 0.55,
  glass = true,
}: AppShellProps<L, R>) {
  return (
    <div
      className="shell"
      data-left-open={leftPanel !== null}
      data-right-open={rightPanel !== null}
      // Glass only means anything over an image. With no background it would cost a
      // compositing layer to blur a flat colour.
      data-glass={backgroundUrl !== null && glass}
      style={
        {
          '--wc-bg-blur': `${backgroundBlur}px`,
          '--wc-bg-dim': backgroundDim,
        } as CSSProperties
      }
    >
      {/*
       * A real element rather than a ::before, so React can set backgroundImage directly.
       * That matters for correctness, not tidiness: sanitizeFilename permits parentheses,
       * so "sunset (2).jpg" would break a url() built from a CSS variable. Going through
       * backgroundApi.url() escapes it.
       */}
      {backgroundUrl ? (
        <div
          className="shell__backdrop"
          aria-hidden="true"
          style={{ backgroundImage: `url("${backgroundUrl}")` }}
        />
      ) : null}
      {backgroundUrl ? <div className="shell__scrim" aria-hidden="true" /> : null}

      <div className="shell__bar">
        <PanelCluster
          buttons={leftButtons}
          active={leftPanel}
          onSelect={onSelectLeft}
          side="left"
        />
        <div className="shell__title">{title}</div>
        <PanelCluster
          buttons={rightButtons}
          active={rightPanel}
          onSelect={onSelectRight}
          side="right"
        />
      </div>

      {/* aria-hidden when closed so collapsed panels leave the tab order entirely. */}
      <aside
        id="panel-left"
        className="panel panel--left"
        aria-hidden={leftPanel === null}
        inert={leftPanel === null || undefined}
      >
        <div className="panel__inner">{left}</div>
      </aside>

      <main className="chat-column">{children}</main>

      <aside
        id="panel-right"
        className="panel panel--right"
        aria-hidden={rightPanel === null}
        inert={rightPanel === null || undefined}
      >
        <div className="panel__inner">{right}</div>
      </aside>
    </div>
  );
}

interface PanelProps {
  /** Omitted for panels whose content names itself; the header is then not rendered. */
  title?: string;
  actions?: ReactNode;
  /** Sits between the header and the scrolling body, so it never scrolls away. */
  chrome?: ReactNode;
  children: ReactNode;
}

/** Standard panel chrome: an optional header, a fixed chrome slot, one scrolling body. */
export function Panel({ title, actions, chrome, children }: PanelProps) {
  return (
    <>
      {title || actions ? (
        <header className="panel__header">
          {title ? <span className="panel__title">{title}</span> : null}
          {actions ? <div className="panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      {chrome}
      <div className="panel__body">{children}</div>
    </>
  );
}
