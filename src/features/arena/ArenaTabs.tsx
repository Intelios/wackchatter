/**
 * The Arena's section tabs and their sliding underline.
 *
 * A real tab set, so real tabs. The app's `aria-pressed` bar convention is for buttons
 * that toggle a panel open and shut; these four are destinations and one is always
 * current, which is what `aria-selected` says and `aria-pressed` cannot.
 *
 * The active mark is one bar per strip, measured to sit under the current tab and moved
 * with transform/width transitions — so hopping from Arena to Pool slides the bar across
 * the gaps instead of two independent underlines toggling. The same scheme as
 * `PanelCluster`, minus everything that made that one subtle: these labels are static
 * (no opening/closing arithmetic in measure()) and a tab is always current (no fade or
 * parked-position state — the bar has somewhere to be from the first paint).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type ArenaMode = 'bench' | 'blind' | 'tournament' | 'board' | 'pool';

const MODES: { id: ArenaMode; label: string }[] = [
  { id: 'bench', label: 'Arena' },
  { id: 'blind', label: 'Benchmark' },
  { id: 'tournament', label: 'Tournament' },
  { id: 'board', label: 'Leaderboard' },
  { id: 'pool', label: 'Pool' },
];

/** Where the underline sits, relative to the strip. */
interface IndicatorRect {
  x: number;
  width: number;
}

interface ArenaTabsProps {
  mode: ArenaMode;
  onChange: (mode: ArenaMode) => void;
}

export function ArenaTabs({ mode, onChange }: ArenaTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<ArenaMode, HTMLButtonElement>());
  const readyRef = useRef(false);
  const [rect, setRect] = useState<IndicatorRect | null>(null);
  const [ready, setReady] = useState(false);

  /*
   * getBoundingClientRect rather than offsetLeft/offsetWidth: those round to whole
   * pixels, and the rounded terms drift independently from the fractional widths a
   * scaled or subpixel-positioned strip produces — the same micro-jank PanelCluster's
   * arithmetic exists to avoid, caught here for free by measuring the same way.
   */
  const measure = useCallback(() => {
    const strip = stripRef.current;
    const button = buttonRefs.current.get(mode);
    if (!strip || !button) return;
    const box = button.getBoundingClientRect();
    const x = box.left - strip.getBoundingClientRect().left;
    const width = box.width;
    // An unchanged rect keeps its predecessor: a resize callback that moved nothing
    // must not re-render the strip over it.
    setRect((prev) =>
      prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.width - width) < 0.5
        ? prev
        : { x, width },
    );
  }, [mode]);

  /*
   * Layout effect, not effect: the bar must be at its final position for the very first
   * paint. The double rAF then switches the transitions on one frame after that
   * placement — without it the bar would animate out of its translateX(0) origin and
   * slide in from the strip's left edge on mount (see .arena-shell__mode-indicator).
   */
  useLayoutEffect(() => {
    measure();
    if (!readyRef.current) {
      readyRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    }
  }, [measure]);

  /*
   * The strip is centred in the bar's `1fr auto 1fr` grid, so relative x only moves when
   * a button's width does — a font swap resizing the labels, most likely. Observing the
   * buttons rather than the strip catches that even when the widths happen to cancel out
   * and leave the strip the same size.
   */
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    for (const button of buttonRefs.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="arena-shell__modes" role="tablist" aria-label="Arena sections" ref={stripRef}>
      {rect ? (
        <span
          aria-hidden="true"
          className="arena-shell__mode-indicator"
          data-ready={ready}
          style={{ transform: `translateX(${rect.x}px)`, width: rect.width }}
        />
      ) : null}
      {MODES.map((entry) => (
        <button
          key={entry.id}
          ref={(el) => {
            if (el) buttonRefs.current.set(entry.id, el);
            else buttonRefs.current.delete(entry.id);
          }}
          type="button"
          role="tab"
          aria-selected={mode === entry.id}
          className="arena-shell__mode"
          onClick={() => onChange(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
