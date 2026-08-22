/**
 * Who is in a corner: choosing the contender that runs one column of the bench.
 *
 * The trigger is dressed as the name — the masthead reads as a scene, not a form row —
 * and it opens the app's own listbox, because Popover is the only popup mechanism here.
 * A native `<select>` was the last operating-system control on the screen, and all it
 * could say about an entrant that could not run was a suffix in brackets; the list says
 * the reason instead.
 *
 * Follows the card picker beside it: role listbox, roving focus through the options,
 * Escape and outside-click dismissal inherited from `Popover`, and focus landed in a
 * layout effect rather than a frame callback.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Popover, type PopoverTriggerProps } from '../../components/Popover.tsx';
import { ChevronIcon } from '../../layout/icons.tsx';
import type { ResolvedContender } from './contenders.ts';
import { contenderLabel } from './contenders.ts';

interface CornerPickerProps {
  resolved: readonly ResolvedContender[];
  /** The contender id currently in this corner, or '' for nobody. */
  value: string;
  onChange: (id: string) => void;
  /** 1-based column number, for the accessible name. */
  column: number;
  /** Which edge of the masthead the corner sits on; the popup grows inward from it. */
  side: 'a' | 'b' | 'n';
}

export function CornerPicker({ resolved, value, onChange, column, side }: CornerPickerProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const selected = resolved.find((entry) => entry.contender.id === value) ?? null;

  const options = useCallback((): HTMLButtonElement[] => {
    const found = popupRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="option"]:not(:disabled)',
    );
    return found ? [...found] : [];
  }, []);

  /*
   * Opening starts from the corner's current occupant, not from the top.
   *
   * A layout effect, not a `requestAnimationFrame`: the popup's DOM already exists by the
   * time this runs, and a frame callback does not fire at all while the window is
   * backgrounded — which would open the picker with focus stranded on `<body>`.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const list = options();
    const current = list.find((option) => option.dataset.contenderId === value) ?? list[0];
    current?.focus({ preventScroll: true });
    // `value` is a dependency and harmlessly so: choosing closes the popup in the same
    // update, so the re-run takes the `!open` branch.
  }, [open, options, value]);

  /** Move focus by `step`. `to` jumps to an absolute index instead. */
  const moveFocus = useCallback(
    (step: number, to?: number) => {
      const list = options();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = to ?? (current === -1 ? 0 : current + step);
      list[Math.max(0, Math.min(next, list.length - 1))]?.focus({ preventScroll: true });
    },
    [options],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveFocus(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveFocus(-1);
          break;
        case 'Home':
          event.preventDefault();
          moveFocus(0, 0);
          break;
        case 'End': {
          event.preventDefault();
          const list = options();
          moveFocus(0, list.length - 1);
          break;
        }
        case 'Tab':
          // Let focus move on naturally; the popup just gets out of the way.
          setOpen(false);
          break;
        default:
          break;
      }
    },
    [moveFocus, options],
  );

  const choose = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
      // A click landed focus on an option that is about to unmount; put it back on the
      // name, so a keyboard pick does not end stranded on `<body>`.
      triggerRef.current?.focus({ preventScroll: true });
    },
    [onChange],
  );

  const renderTrigger = (props: PopoverTriggerProps) => (
    <button
      type="button"
      className="arena-corner__pickbtn"
      data-empty={selected === null}
      onClick={() => setOpen(!open)}
      {...props}
      ref={(node) => {
        props.ref(node);
        triggerRef.current = node;
      }}
    >
      <span className="arena-corner__pickname">
        {selected ? contenderLabel(selected.contender, selected.connection) : 'Choose a contender…'}
      </span>
      <ChevronIcon className="arena-corner__chevron" />
    </button>
  );

  return (
    <Popover
      label={`Contender for column ${column}`}
      icon={null}
      open={open}
      onOpenChange={setOpen}
      className="arena-cornerpicker"
      popupClassName="arena-cornerpicker__popup"
      placement={side === 'b' ? 'bottom-end' : 'bottom-start'}
      role="listbox"
      popupRef={popupRef}
      onKeyDown={onKeyDown}
      renderTrigger={renderTrigger}
    >
      {resolved.length === 0 ? (
        <p className="arena-cornerpicker__empty">No contenders yet — add some in Pool.</p>
      ) : (
        <div className="arena-cornerpicker__list">
          {resolved.map((item) => {
            const unavailable = item.connection === null;
            return (
              <button
                type="button"
                key={item.contender.id}
                role="option"
                className="arena-cornerpicker__option"
                data-contender-id={item.contender.id}
                data-on={item.contender.id === value}
                aria-selected={item.contender.id === value}
                tabIndex={-1}
                disabled={unavailable}
                title={unavailable ? (item.unavailableReason ?? undefined) : undefined}
                onClick={() => choose(item.contender.id)}
              >
                <span className="arena-cornerpicker__name">
                  {contenderLabel(item.contender, item.connection)}
                </span>
                {unavailable ? (
                  <span className="arena-cornerpicker__why">{item.unavailableReason}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}
