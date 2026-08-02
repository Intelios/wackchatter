/**
 * A popup menu of actions.
 *
 * Data-driven like `Tabs` rather than composed from children: a list of tools *is* a list,
 * and keeping it as data is what lets the entries be built by a pure, testable function
 * instead of by JSX.
 *
 * The popup itself — opening, flipping, dismissal, ARIA — is `Popover`. What lives here is
 * only what a *menu* adds on top: entry rendering and roving arrow-key focus.
 *
 * It owns its open state because nothing outside cares about it; `Section` sets the same
 * precedent. Non-modal, so there is no focus trap — focus may leave, and when it does via
 * Tab the menu simply closes.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Popover, type PopoverPlacement } from './Popover.tsx';
import './Menu.css';

export interface MenuAction {
  kind?: 'item';
  label: string;
  icon?: ReactNode;
  /** Right-aligned secondary text, e.g. a count or a shortcut. */
  hint?: string;
  disabled?: boolean;
  /** Why it is disabled. Becomes the `title`, so a greyed item still explains itself. */
  disabledReason?: string;
  danger?: boolean;
  onSelect: () => void;
  /** Stay open after selecting — the hook for a future two-click destructive entry. */
  keepOpen?: boolean;
}

export interface MenuSeparator {
  kind: 'separator';
}

export type MenuEntry = MenuAction | MenuSeparator;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return entry.kind === 'separator';
}

export type MenuPlacement = PopoverPlacement;

interface MenuProps {
  /** Accessible name for the trigger, and its tooltip. */
  label: string;
  icon: ReactNode;
  entries: MenuEntry[];
  className?: string;
  placement?: MenuPlacement;
}

export function Menu({ label, icon, entries, className, placement = 'top-start' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  /** Close and put focus back where it started, so keyboard users are not stranded. */
  const closeAndRestore = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  // The enabled items, in order. Queried from the DOM rather than kept in a ref array:
  // the entries are data, so the rendered list is already the only ordering that matters.
  const items = useCallback((): HTMLButtonElement[] => {
    const found = popupRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    return found ? [...found] : [];
  }, []);

  // Focus the first enabled item on open, so the keyboard path starts somewhere useful.
  //
  // `preventScroll` is not optional: the popup is already positioned in view by CSS, and
  // letting the browser scroll to "reveal" it moves the whole app under a layout that is
  // supposed to be fixed to the viewport.
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus({ preventScroll: true });
  }, [open, items]);

  /** Move focus by `step`, wrapping. `to` jumps to an absolute index instead. */
  function moveFocus(step: number, to?: number) {
    const list = items();
    if (!list.length) return;

    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = to ?? (current === -1 ? 0 : (current + step + list.length) % list.length);
    list[Math.max(0, Math.min(next, list.length - 1))]?.focus({ preventScroll: true });
  }

  // Escape is Popover's; everything here is the roving-focus behaviour a menu adds.
  function onKeyDown(event: ReactKeyboardEvent) {
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
      case 'End':
        event.preventDefault();
        moveFocus(0, items().length - 1);
        break;
      case 'Tab':
        // Let focus move on naturally; the menu just gets out of the way.
        setOpen(false);
        break;
      default:
        break;
    }
  }

  function select(entry: MenuAction) {
    entry.onSelect();
    if (!entry.keepOpen) closeAndRestore();
  }

  return (
    <Popover
      label={label}
      icon={icon}
      open={open}
      onOpenChange={setOpen}
      className={`menu${className ? ` ${className}` : ''}`}
      popupClassName="menu__popup"
      placement={placement}
      role="menu"
      triggerRef={triggerRef}
      popupRef={popupRef}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) =>
        isSeparator(entry) ? (
          // <hr> rather than a div with role="separator": the role is implicit, and a
          // div carrying it explicitly is expected to be focusable (a splitter).
          // biome-ignore lint/suspicious/noArrayIndexKey: separators carry no identity
          <hr className="menu__separator" key={`sep-${index}`} />
        ) : (
          <button
            type="button"
            key={entry.label}
            role="menuitem"
            className="menu__item"
            data-danger={entry.danger || undefined}
            disabled={entry.disabled}
            title={entry.disabled ? entry.disabledReason : undefined}
            // -1 because focus is driven by the arrow keys, not the tab order.
            tabIndex={-1}
            onClick={() => select(entry)}
          >
            <span className="menu__icon">{entry.icon}</span>
            <span className="menu__label">{entry.label}</span>
            {entry.hint ? <span className="menu__hint">{entry.hint}</span> : null}
          </button>
        ),
      )}
    </Popover>
  );
}
