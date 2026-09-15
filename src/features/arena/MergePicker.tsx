/**
 * Folding one contender's recorded rounds under another's identity.
 *
 * The reason this exists: a contender is an endpoint plus a model, which is what the bench
 * runs, but the board is read as "which *model* writes best". One LLM behind two providers
 * arrives as two entrants — the same weights ranked against itself, each with half the
 * history. Merging says those two are one model.
 *
 * Two rules the control follows, both from the app's own conventions. The picker offers only
 * entries that are themselves unmerged, so a merge is always a single link to a root and
 * never a chain the reader has to resolve. And unmerging is a plain button, not a confirmed
 * destructive action: nothing was rewritten, so a split is exact and free to redo — the
 * confirmations in this panel are for things that lose data, and this does not.
 */

import type { Contender } from '@shared/types/arena.ts';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Popover, type PopoverTriggerProps } from '../../components/Popover.tsx';
import { LayersIcon } from '../../layout/icons.tsx';
import { contenderLabel, type ResolvedContender } from './contenders.ts';
import { canonicalId, canonicalMap, type MergeMap } from './merges.ts';

interface MergePickerProps {
  /** The contender whose rounds would be folded. */
  source: Contender;
  /** The whole pool, so a target can be named the same way the roster names it. */
  resolved: readonly ResolvedContender[];
  merged: MergeMap;
  onMerge: (targetId: string) => void;
}

export function MergePicker({ source, resolved, merged, onMerge }: MergePickerProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  /**
   * The entries this one may be folded into: everything else that is a root.
   *
   * A merged entry is excluded, so the map always describes one level from a root rather
   * than a chain — and the entry currently folded into this one is excluded too, because
   * folding two entries into each other is a loop, not a merge.
   */
  const candidates = useMemo(() => {
    const canonical = canonicalMap(merged);
    return resolved.filter((entry) => {
      if (entry.contender.id === source.id) return false;
      if (canonicalId(canonical, entry.contender.id) !== entry.contender.id) return false;
      return merged[entry.contender.id] !== source.id;
    });
  }, [merged, resolved, source.id]);

  const options = useCallback((): HTMLButtonElement[] => {
    const found = popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    return found ? [...found] : [];
  }, []);

  // Land focus inside the popup the moment it opens — a layout effect, so a backgrounded
  // window does not leave focus stranded on `<body>` (a frame callback never fires there).
  useLayoutEffect(() => {
    if (!open) return;
    options()[0]?.focus({ preventScroll: true });
  }, [open, options]);

  const moveFocus = useCallback(
    (step: number) => {
      const list = options();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = Math.max(0, Math.min(current + step, list.length - 1));
      list[current === -1 ? 0 : next]?.focus({ preventScroll: true });
    },
    [options],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveFocus(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocus(-1);
      } else if (event.key === 'Tab') {
        setOpen(false);
      }
    },
    [moveFocus],
  );

  const choose = useCallback(
    (targetId: string) => {
      onMerge(targetId);
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    },
    [onMerge],
  );

  const renderTrigger = (props: PopoverTriggerProps) => (
    <button
      type="button"
      className="wc-button wc-button--ghost arena-entrant__merge"
      onClick={() => setOpen(!open)}
      {...props}
      ref={(node) => {
        props.ref(node);
        triggerRef.current = node;
      }}
    >
      <LayersIcon />
      Merge into…
    </button>
  );

  return (
    <Popover
      label={
        candidates.length === 0
          ? `Merge ${contenderLabel(source)} — add another contender first`
          : `Merge ${contenderLabel(source)} into another contender`
      }
      icon={<LayersIcon />}
      open={open}
      onOpenChange={setOpen}
      className="arena-mergepicker"
      popupClassName="arena-mergepicker__popup"
      placement="bottom-start"
      role="listbox"
      popupRef={popupRef}
      onKeyDown={onKeyDown}
      disabled={candidates.length === 0}
      disabledReason="Merge: count this contender’s rounds under another one. Add a second contender to merge into."
      renderTrigger={renderTrigger}
    >
      <p className="arena-mergepicker__hint">Count this contender&rsquo;s rounds under:</p>
      <div className="arena-mergepicker__list">
        {candidates.map((entry) => (
          <button
            type="button"
            key={entry.contender.id}
            role="option"
            aria-selected={false}
            tabIndex={-1}
            className="arena-mergepicker__option"
            data-contender-id={entry.contender.id}
            onClick={() => choose(entry.contender.id)}
          >
            <span className="arena-mergepicker__name">
              {contenderLabel(entry.contender, entry.connection)}
            </span>
          </button>
        ))}
      </div>
      <p className="arena-mergepicker__note">
        Both keep their rounds. Nothing is rewritten, so you can split them again at any time.
      </p>
    </Popover>
  );
}
