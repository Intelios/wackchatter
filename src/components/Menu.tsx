/**
 * A popup menu of actions.
 *
 * Data-driven like `Tabs` rather than composed from children: a list of tools *is* a list,
 * and keeping it as data is what lets the entries be built by a pure, testable function
 * instead of by JSX.
 *
 * The popup itself — opening, flipping, dismissal, ARIA — is `Popover`. What lives here is
 * only what a *menu* adds on top: entry rendering, roving arrow-key focus, and the flyout
 * a `submenu` entry opens to one side.
 *
 * It owns its open state because nothing outside cares about it; `Section` sets the same
 * precedent. Non-modal, so there is no focus trap — focus may leave, and when it does via
 * Tab the menu simply closes.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ChevronIcon } from '../layout/icons.tsx';
import { Popover, type PopoverPlacement } from './Popover.tsx';
import './Menu.css';

export interface MenuAction {
  kind?: 'item';
  label: string;
  /**
   * React key. Defaults to the label, which is unique among the fixed entries — but a list
   * of user-named entries can repeat a name, so those carry their own identity.
   */
  key?: string;
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

/**
 * An entry that opens a second menu to the side — hover it, or press ArrowRight on it.
 * The flyout is part of this menu, not a separate Popover: it only exists while the parent
 * is open, so it inherits the parent's dismissal instead of growing its own.
 */
export interface MenuSubmenu {
  kind: 'submenu';
  label: string;
  key?: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
  entries: MenuEntry[];
}

export type MenuEntry = MenuAction | MenuSeparator | MenuSubmenu;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return entry.kind === 'separator';
}

export function isSubmenu(entry: MenuEntry): entry is MenuSubmenu {
  return entry.kind === 'submenu';
}

export type MenuPlacement = PopoverPlacement;

interface MenuProps {
  /** Accessible name for the trigger, and its tooltip. */
  label: string;
  icon: ReactNode;
  entries: MenuEntry[];
  className?: string;
  placement?: MenuPlacement;
  /**
   * Told when the menu opens or closes. The menu still owns the state — this is for a caller
   * holding state *about* an entry, such as a two-click confirm that has to disarm itself
   * when the user dismisses the menu instead of confirming.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Filled with the trigger button. For a caller that anchors a second popup to the same
   * button — the chat menu's quick-commands editor opens from inside the menu, but it
   * grows out of the burger itself.
   */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/** Identity of an entry that may not have a `key`: the label, which is then unique enough. */
function keyOf(entry: MenuAction | MenuSubmenu): string {
  return entry.key ?? entry.label;
}

export function Menu({
  label,
  icon,
  entries,
  className,
  placement = 'top-start',
  onOpenChange,
  triggerRef: externalTriggerRef,
}: MenuProps) {
  const [open, setOpen] = useState(false);

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setOpenKey(null);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const ownTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? ownTriggerRef;
  const popupRef = useRef<HTMLDivElement>(null);

  // The flyout currently open, by entry key, plus the element it grows from. The entry
  // itself is re-found in `entries` on every render — the caller rebuilds the list, so a
  // stored copy would go stale underneath us.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [focusFlyout, setFocusFlyout] = useState(false);
  const submenuAnchorRef = useRef<HTMLElement | null>(null);
  const submenuCloseTimer = useRef<number | undefined>(undefined);

  const cancelSubmenuClose = useCallback(() => {
    window.clearTimeout(submenuCloseTimer.current);
  }, []);

  // A grace period, so the pointer can cross the gap between the item and its flyout
  // without dropping the hover.
  const scheduleSubmenuClose = useCallback(() => {
    window.clearTimeout(submenuCloseTimer.current);
    submenuCloseTimer.current = window.setTimeout(() => setOpenKey(null), 150);
  }, []);

  const openSubmenu = useCallback(
    (entry: MenuSubmenu, anchor: HTMLElement | null, focus: boolean) => {
      cancelSubmenuClose();
      submenuAnchorRef.current = anchor;
      setFocusFlyout(focus);
      setOpenKey(keyOf(entry));
    },
    [cancelSubmenuClose],
  );

  const closeSubmenu = useCallback(() => {
    cancelSubmenuClose();
    setOpenKey(null);
  }, [cancelSubmenuClose]);

  useEffect(() => () => window.clearTimeout(submenuCloseTimer.current), []);

  /** Close and put focus back where it started, so keyboard users are not stranded. */
  const closeAndRestore = useCallback(() => {
    setOpenState(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, [setOpenState, triggerRef]);

  // The enabled items, in order. Queried from the DOM rather than kept in a ref array:
  // the entries are data, so the rendered list is already the only ordering that matters.
  const items = useCallback((): HTMLButtonElement[] => {
    const found = popupRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    if (!found) return [];
    // Flyout items belong to their own menu; the parent's roving focus stays on the parent.
    return [...found].filter((item) => item.closest('[role="menu"]') === popupRef.current);
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
  function moveFocus(list: HTMLButtonElement[], step: number, to?: number) {
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
        closeSubmenu();
        moveFocus(items(), 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        closeSubmenu();
        moveFocus(items(), -1);
        break;
      case 'Home':
        event.preventDefault();
        closeSubmenu();
        moveFocus(items(), 0, 0);
        break;
      case 'End':
        event.preventDefault();
        closeSubmenu();
        moveFocus(items(), 0, items().length - 1);
        break;
      case 'ArrowRight': {
        // Opens the flyout of the submenu under focus, the keyboard's hover.
        const key = (document.activeElement as HTMLElement | null)?.getAttribute?.(
          'data-submenu-key',
        );
        if (!key) break;
        const entry = entries.find(
          (candidate): candidate is MenuSubmenu => isSubmenu(candidate) && keyOf(candidate) === key,
        );
        if (!entry || entry.disabled) break;
        event.preventDefault();
        openSubmenu(entry, (document.activeElement as HTMLElement).parentElement, true);
        break;
      }
      case 'Tab':
        // Let focus move on naturally; the menu just gets out of the way.
        setOpenState(false);
        break;
      default:
        break;
    }
  }

  function select(entry: MenuAction) {
    entry.onSelect();
    if (!entry.keepOpen) closeAndRestore();
  }

  function renderAction(entry: MenuAction) {
    return (
      <button
        type="button"
        key={keyOf(entry)}
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
    );
  }

  return (
    <Popover
      label={label}
      icon={icon}
      open={open}
      onOpenChange={setOpenState}
      className={`menu${className ? ` ${className}` : ''}`}
      popupClassName="menu__popup"
      placement={placement}
      role="menu"
      triggerRef={triggerRef}
      popupRef={popupRef}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => {
        if (isSeparator(entry)) {
          return (
            // <hr> rather than a div with role="separator": the role is implicit, and a
            // div carrying it explicitly is expected to be focusable (a splitter).
            // biome-ignore lint/suspicious/noArrayIndexKey: separators carry no identity
            <hr className="menu__separator" key={`sep-${index}`} />
          );
        }

        if (isSubmenu(entry)) {
          const isOpen = openKey === keyOf(entry);
          return (
            <div key={keyOf(entry)} className="menu__item-wrap">
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                data-submenu-key={keyOf(entry)}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                disabled={entry.disabled}
                title={entry.disabled ? entry.disabledReason : undefined}
                tabIndex={-1}
                // Hover opens without taking focus; the grace period on leaving covers the
                // gap the pointer crosses to reach the flyout.
                onMouseEnter={(event) => {
                  if (!entry.disabled) openSubmenu(entry, event.currentTarget.parentElement, false);
                }}
                onMouseLeave={scheduleSubmenuClose}
                onClick={(event) => {
                  if (isOpen) closeSubmenu();
                  else openSubmenu(entry, event.currentTarget.parentElement, true);
                }}
              >
                <span className="menu__icon">{entry.icon}</span>
                <span className="menu__label">{entry.label}</span>
                {entry.hint ? <span className="menu__hint">{entry.hint}</span> : null}
                <ChevronIcon className="menu__chevron" />
              </button>

              {isOpen ? (
                <Submenu
                  entry={entry}
                  anchor={submenuAnchorRef.current}
                  focusOnOpen={focusFlyout}
                  onSelect={select}
                  onClose={() => {
                    closeSubmenu();
                    // Back to the item the flyout grew from, so the keyboard path is a loop.
                    submenuAnchorRef.current
                      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
                      ?.focus({ preventScroll: true });
                  }}
                  onDismissAll={closeAndRestore}
                  onEnter={cancelSubmenuClose}
                  onLeave={scheduleSubmenuClose}
                />
              ) : null}
            </div>
          );
        }

        return renderAction(entry);
      })}
    </Popover>
  );
}

interface SubmenuProps {
  entry: MenuSubmenu;
  /** The element the flyout grows from — measured once, on open. */
  anchor: HTMLElement | null;
  /** Keyboard- and click-opened flyouts take focus; hover-opened ones do not. */
  focusOnOpen: boolean;
  /** Runs an action and closes the whole menu. */
  onSelect: (entry: MenuAction) => void;
  /** Closes only the flyout; the caller restores focus to its trigger. */
  onClose: () => void;
  /** Closes everything — the flyout's Tab matches the parent menu's. */
  onDismissAll: () => void;
  onEnter: () => void;
  onLeave: () => void;
}

/**
 * The flyout of a submenu entry.
 *
 * `position: fixed` rather than a nested Popover: the menu popup scrolls when it is taller
 * than its room, and anything absolutely positioned inside it would be clipped by that
 * scroll container. No ancestor of the popup carries a transform or a filter — glass puts
 * its backdrop-filter on the bar and the panels, never here — so fixed is anchored to the
 * viewport and escapes the clipping, while staying a DOM child of the menu: the parent's
 * outside-click dismissal still contains it, and closing the menu unmounts it.
 */
function Submenu({
  entry,
  anchor,
  focusOnOpen,
  onSelect,
  onClose,
  onDismissAll,
  onEnter,
  onLeave,
}: SubmenuProps) {
  const flyoutRef = useRef<HTMLDivElement>(null);

  // Place the flyout beside its anchor, on whichever side fits, clamped to the viewport.
  // Direct style writes in a layout effect land before paint, so there is no first frame
  // in the wrong place.
  useLayoutEffect(() => {
    const flyout = flyoutRef.current;
    if (!flyout || !anchor) return;

    const rect = anchor.getBoundingClientRect();
    const margin = 8;

    let side: 'right' | 'left' = 'right';
    let left = rect.right;
    if (left + flyout.offsetWidth > window.innerWidth - margin) {
      side = 'left';
      left = rect.left;
    }

    const top = Math.max(
      margin,
      Math.min(rect.top - 5, window.innerHeight - flyout.offsetHeight - margin),
    );

    flyout.style.left = `${left}px`;
    flyout.style.top = `${top}px`;
    flyout.dataset.side = side;
  }, [anchor]);

  const items = useCallback((): HTMLButtonElement[] => {
    const found = flyoutRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    return found ? [...found] : [];
  }, []);

  useEffect(() => {
    if (!focusOnOpen) return;
    items()[0]?.focus({ preventScroll: true });
  }, [focusOnOpen, items]);

  function moveFocus(step: number, to?: number) {
    const list = items();
    if (!list.length) return;

    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = to ?? (current === -1 ? 0 : (current + step + list.length) % list.length);
    list[Math.max(0, Math.min(next, list.length - 1))]?.focus({ preventScroll: true });
  }

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
      case 'Escape':
      case 'ArrowLeft':
        // The parent menu, not the Popover, takes this one: the flyout closes, the menu
        // stays. Without the stop, Popover's Escape would dismiss everything.
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case 'Tab':
        onDismissAll();
        break;
      default:
        break;
    }
  }

  return (
    <div ref={flyoutRef} className="menu__submenu">
      {/* The handlers sit on the box, not the positioning bridge around it: the bridge is
          presentational, and the wrapper's own hover already spans the gap. */}
      <div
        className="menu__submenu-box"
        role="menu"
        aria-label={entry.label}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onKeyDown={onKeyDown}
      >
        {entry.entries.map((child, index) =>
          isSeparator(child) ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: separators carry no identity
            <hr className="menu__separator" key={`sep-${index}`} />
          ) : isSubmenu(child) ? null : (
            renderFlyoutAction(child)
          ),
        )}
      </div>
    </div>
  );

  function renderFlyoutAction(child: MenuAction) {
    return (
      <button
        type="button"
        key={keyOf(child)}
        role="menuitem"
        className="menu__item"
        data-danger={child.danger || undefined}
        disabled={child.disabled}
        title={child.disabled ? child.disabledReason : undefined}
        tabIndex={-1}
        onClick={() => onSelect(child)}
      >
        <span className="menu__icon">{child.icon}</span>
        <span className="menu__label">{child.label}</span>
        {child.hint ? <span className="menu__hint">{child.hint}</span> : null}
      </button>
    );
  }
}
