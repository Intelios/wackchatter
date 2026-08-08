import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Backdrop } from '../components/Backdrop.tsx';
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
 *
 * Only that active button is labelled; the rest are icons carrying a `title`. Which is
 * why measuring the pill is not simply reading the button — see measure() below.
 */
function PanelCluster<T extends string>({ buttons, active, onSelect, side }: PanelClusterProps<T>) {
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const readyRef = useRef(false);
  const [rect, setRect] = useState<IndicatorRect | null>(null);
  const [ready, setReady] = useState(false);

  /*
   * Where the pill will end up once the labels finish moving — not where they are now.
   *
   * A press sets two things in motion: the incoming label opens and the outgoing one
   * closes, both over --wc-duration (see AppShell.css). Reads taken on the frame the
   * press lands therefore see the old label still open and the new one still shut.
   * Watching the transition frame by frame is the obvious fix and a worse one: it makes
   * the pill depend on ResizeObserver callbacks actually being delivered, and a document
   * that is not rendering gets none — switch tabs on the same frame as the click and the
   * pill is stranded mid-cluster with the transition already over and nothing left to
   * correct it. So take the terms that are true at every point in the animation instead.
   *
   * x is the button's left edge minus the current width of every label before it. A
   * closing label still holds that much width and pushes everything after it right of
   * where it will land — by exactly that amount; a label at rest holds none. So the
   * subtraction yields the final x on the press frame and on every frame of the close.
   *
   * width is the button without its label, plus the width that label is opening to.
   * scrollWidth, not a rendered width, for the second term: the span is clipped by the
   * collapsing grid, and only scrollWidth still reports the width its content wants.
   *
   * getBoundingClientRect rather than offsetLeft/offsetWidth for all of it: those round
   * to whole pixels, and the rounded terms in x drift independently frame to frame
   * mid-close, so an offsetLeft pill target wobbles a pixel either way while the labels
   * move — the exact micro-jank this arithmetic exists to avoid.
   */
  const measure = useCallback(() => {
    const button = active ? buttonRefs.current.get(active) : undefined;
    if (!button) return;
    const label = button.querySelector<HTMLElement>('.panel-toggle__label');
    const text = button.querySelector<HTMLElement>('.panel-toggle__label > span');
    const cluster = button.offsetParent;
    const box = button.getBoundingClientRect();
    let x = box.left - (cluster?.getBoundingClientRect().left ?? 0);
    for (const spec of buttons) {
      if (spec.id === active) break;
      const otherLabel = buttonRefs.current
        .get(spec.id)
        ?.querySelector<HTMLElement>('.panel-toggle__label');
      if (otherLabel) x -= otherLabel.getBoundingClientRect().width;
    }
    const width =
      box.width - (label?.getBoundingClientRect().width ?? 0) + (text?.scrollWidth ?? 0);
    /*
     * The ResizeObserver fires on every frame of the label animation; handing back the
     * previous object when nothing moved keeps that from re-rendering the cluster for a
     * rect that has not changed.
     */
    setRect((prev) =>
      prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.width - width) < 0.5
        ? prev
        : { x, width },
    );
  }, [active, buttons]);

  /*
   * Layout effect, not effect: the pill must be at its final position for the very first
   * paint, or a no-transition frame shows it at width 0 before the position lands.
   */
  useLayoutEffect(() => {
    measure();
    if (!readyRef.current && active) {
      readyRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    }
  }, [measure, active]);

  /*
   * Everything measure() reads can still change without a press: the narrow-window query
   * collapses the last label, and a font swap resizes the text inside it. Observing the
   * buttons rather than the cluster catches the second one even when the widths happen to
   * cancel out and leave the cluster the same size.
   */
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    for (const button of buttonRefs.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="shell__cluster">
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
          {/* The inner span is the clipped grid item — see .panel-toggle__label. */}
          <span className="panel-toggle__label">
            <span>{button.label}</span>
          </span>
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
 *
 * The bar carries the two clusters and nothing else. What sat between them was a caption
 * naming the character and chat, and it was redundant against the transcript, the
 * composer and the home screen's own wordmark — see the note on documentTitle in App.tsx,
 * which is where that string went. Leaving the middle to the background image is the
 * point rather than a gap: the bar is glass over the user's picture, so empty here is
 * their image running unbroken across the top, not a hole in a toolbar.
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
  children,
  backgroundUrl = null,
  backgroundBlur = 8,
  backgroundDim = 0.55,
  glass = true,
}: AppShellProps<L, R>) {
  return (
    <div
      className="shell"
      data-overlay-root
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
       * backgroundApi.url() escapes it. Backdrop also crossfades between pictures.
       */}
      <Backdrop url={backgroundUrl} />
      {backgroundUrl ? <div className="shell__scrim" aria-hidden="true" /> : null}

      <div className="shell__bar">
        <PanelCluster
          buttons={leftButtons}
          active={leftPanel}
          onSelect={onSelectLeft}
          side="left"
        />
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
