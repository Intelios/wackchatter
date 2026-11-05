/**
 * The island: one object at the top of the screen that changes shape.
 *
 * At rest it says who is in the scene. While a reply is written it becomes the live status
 * and its Stop. Opened, it becomes whatever you are choosing from: a character or chat,
 * your persona, anything at all (⌘K), or the recap. Its wings fold out of either side on
 * hover and hold the tools.
 *
 * Every pane stays mounted, so the target of a morph can be measured before it is shown;
 * the island animates its own width and height to the active pane's, and the panes cross-
 * fade inside it. Only choosing among many things opens it: direct actions never live here.
 */

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons.tsx';

export type IslandMode = 'rest' | 'gen' | 'cast' | 'persona' | 'search' | 'recap';

export interface IslandNotice {
  id: number;
  icon: IconName;
  /** The bold lead, e.g. "Memory". */
  title: string;
  /** What happened, after the lead. */
  text?: string;
  tone?: 'bad';
  /** Stays until dismissed or acted on, rather than fading. */
  sticky?: boolean;
  action?: { label: string; run: () => void };
}

interface IslandProps {
  mode: IslandMode;
  generating: boolean;
  panes: Partial<Record<IslandMode, ReactNode>>;
  wingLeft: ReactNode;
  wingRight: ReactNode;
  /** Keeps the wings out, e.g. while a tool they opened is showing. */
  wingsPinned: boolean;
  notice: IslandNotice | null;
  onDismissNotice: () => void;
  /** Collapse an opened pane back to rest. */
  onCollapse: () => void;
}

const OPEN_MODES: ReadonlySet<IslandMode> = new Set(['cast', 'persona', 'search', 'recap']);

export function Island({
  mode,
  generating,
  panes,
  wingLeft,
  wingRight,
  wingsPinned,
  notice,
  onDismissNotice,
  onCollapse,
}: IslandProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const islandRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<IslandMode, HTMLDivElement>());
  const [ready, setReady] = useState(false);
  const [wingsOut, setWingsOut] = useState(false);
  const wingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const open = OPEN_MODES.has(mode);

  // Size the island to the active pane, and keep it sized as that pane's content changes.
  useLayoutEffect(() => {
    const island = islandRef.current;
    const pane = paneRefs.current.get(mode);
    if (!island || !pane) return;
    const fit = () => {
      island.style.width = `${pane.offsetWidth}px`;
      island.style.height = `${pane.offsetHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [mode]);

  // Transitions switch on after the first size lands, so the island does not grow in from
  // nothing when the app opens.
  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(frame);
  }, []);

  // An opened island closes on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) onCollapse();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCollapse();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onCollapse]);

  useEffect(() => () => clearTimeout(wingTimer.current), []);

  // A notice fades on its own unless it asks to stay.
  useEffect(() => {
    if (!notice || notice.sticky) return;
    const timer = setTimeout(onDismissNotice, 3200);
    return () => clearTimeout(timer);
  }, [notice, onDismissNotice]);

  const showWings = () => {
    clearTimeout(wingTimer.current);
    setWingsOut(true);
  };
  // A short grace, so crossing the gap between the island and a wing does not fold it.
  const hideWings = () => {
    clearTimeout(wingTimer.current);
    wingTimer.current = setTimeout(() => setWingsOut(false), 450);
  };

  return (
    <div className="w3-island-anchor">
      <div
        ref={wrapRef}
        className="w3-island-wrap"
        data-wings={wingsOut || wingsPinned || undefined}
        onPointerEnter={showWings}
        onPointerLeave={hideWings}
        onFocus={showWings}
        onBlur={(event) => {
          if (!wrapRef.current?.contains(event.relatedTarget as Node)) hideWings();
        }}
      >
        <div
          ref={islandRef}
          className="w3-island"
          data-ready={ready || undefined}
          data-open={open || undefined}
          data-generating={generating || undefined}
        >
          {(Object.keys(panes) as IslandMode[]).map((key) => (
            <div
              key={key}
              ref={(element) => {
                if (element) paneRefs.current.set(key, element);
                else paneRefs.current.delete(key);
              }}
              className={`w3-pane w3-pane--${key}`}
              data-on={key === mode || undefined}
              inert={key !== mode || undefined}
            >
              {panes[key]}
            </div>
          ))}
        </div>

        <nav className="w3-wing w3-wing--left" aria-label="Library">
          {wingLeft}
        </nav>
        <nav className="w3-wing w3-wing--right" aria-label="Tools">
          {wingRight}
        </nav>

        <div
          className="w3-notice"
          data-on={notice ? true : undefined}
          data-tone={notice?.tone}
          role="status"
          aria-live="polite"
        >
          {notice ? (
            <>
              <Icon name={notice.icon} />
              <span>
                <b>{notice.title}</b>
                {notice.text ? ` · ${notice.text}` : null}
              </span>
              {notice.action ? (
                <button
                  type="button"
                  className="w3-notice__action"
                  onClick={() => {
                    notice.action?.run();
                    onDismissNotice();
                  }}
                >
                  {notice.action.label}
                </button>
              ) : null}
              {notice.sticky ? (
                <button
                  type="button"
                  className="w3-notice__close"
                  aria-label="Dismiss"
                  onClick={onDismissNotice}
                >
                  <Icon name="close" size="xs" />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One tool on a wing: an icon with its name as a tooltip. */
export function WingButton({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: IconName;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="w3-wing__btn"
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}
