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
  type CSSProperties,
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
  /**
   * Right-aligned secondary text. Short things only — a count, a shortcut, a snippet: it
   * shares one line with the label and does not shrink. A clause belongs in `description`.
   */
  hint?: string;
  /** A clarifying line under the label, for a consequence the label cannot carry alone. */
  description?: string;
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
 * A family label above a run of related entries — an eyebrow, not an action. It also opens
 * a visual group: the renderer wraps the header and the entries that follow it, so the CSS
 * can tint the whole run with one hue and light the header up when any row in it is hovered.
 *
 * `hue` indexes the `--wc-series-*` palette, the same palette charts and the Nexus use, so
 * a colour here cannot drift from the app's other categorisation.
 */
export type MenuHue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface MenuHeader {
  kind: 'header';
  label: string;
  /** React key. Defaults to the label. */
  key?: string;
  hue?: MenuHue;
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
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
  entries: MenuEntry[];
}

export type MenuEntry = MenuAction | MenuSeparator | MenuHeader | MenuSubmenu;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return entry.kind === 'separator';
}

export function isHeader(entry: MenuEntry): entry is MenuHeader {
  return entry.kind === 'header';
}

export function isSubmenu(entry: MenuEntry): entry is MenuSubmenu {
  return entry.kind === 'submenu';
}

/**
 * A rendered run: optionally a header, then its entries. A bare separator gets a node of its
 * own rather than joining a run — that is what keeps the run after it its own group, so the
 * tint of the group above cannot bleed onto an entry like "Close chat" that carries danger
 * styling of its own.
 */
export interface MenuGroup {
  header?: MenuHeader;
  entries: (MenuAction | MenuSubmenu)[];
  /** A bare separator, standing alone between runs. */
  separator?: boolean;
}

/**
 * Split a flat entry list into header-led runs, splitting on separators as well. Exported
 * because it is the one part of the grouping that is pure — the tests pin it without a DOM.
 * Entries before any header form an implicit, untinted run.
 */
export function groupMenuEntries(entries: MenuEntry[]): MenuGroup[] {
  const groups: MenuGroup[] = [];
  for (const entry of entries) {
    if (isSeparator(entry)) {
      groups.push({ entries: [], separator: true });
      continue;
    }
    if (isHeader(entry)) {
      groups.push({ header: entry, entries: [] });
      continue;
    }
    const current = groups[groups.length - 1];
    if (!current || current.separator) groups.push({ entries: [entry] });
    else current.entries.push(entry);
  }
  return groups;
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
  showLabel?: boolean;
  /**
   * Extra class on the popup itself. The one hook a caller has to skin a particular menu
   * (the chat burger adds its family-lit treatment here); the entry rendering stays shared.
   */
  popupClassName?: string;
  /**
   * Header keys the user has collapsed. A collapsed family's rows stay mounted just long
   * enough to play the collapse animation, then unmount — the `Section` rule — and the
   * roving-focus query skips anything inside a collapsed group either way, so hidden rows
   * hold no focus slot.
   *
   * Which keys are collapsed is the caller's state, not the menu's: the popup unmounts when
   * it closes, so a `useState` in here would forget the choice on every close.
   */
  collapsedKeys?: ReadonlySet<string>;
  /**
   * Makes every header a toggle button. Omitted, headers stay inert labels — the default,
   * so a menu that has not asked for collapsing renders exactly as it did before.
   */
  onToggleGroup?: (key: string) => void;
}

/** Identity of an entry that may not have a `key`: the label, which is then unique enough. */
function keyOf(entry: MenuAction | MenuSubmenu | MenuHeader): string {
  return entry.key ?? entry.label;
}

/**
 * How long a collapsing family keeps its rows mounted for the exit animation. Must outlive
 * the body's `grid-template-rows` transition in Menu.css (`var(--wc-duration)`, 260 ms) by
 * a frame or two, or the rows would vanish mid-shrink.
 */
const GROUP_COLLAPSE_MS = 300;

/** Shared empty set, so menus without collapsing never allocate one per render. */
const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * The stagger's slot: the ordinal of a header or item *within its family*, read by CSS as
 * `--i`. Per-group rather than down the whole menu, so re-opening one collapsed family
 * later gets the same quick one-by-one reveal the initial open has — starting immediately,
 * not after the families above it have taken their turn.
 */
function indexStyle(index: number): CSSProperties {
  return { '--i': index } as CSSProperties;
}

/**
 * The inside of an entry's button, shared by the three places that render one — an action,
 * a submenu's trigger, and an action inside a flyout. One copy so a new slot cannot arrive
 * in two of the three and be quietly missing from the third.
 *
 * The label and its description are one column, so a description pushes the second line
 * under the label rather than into the hint's lane.
 */
function EntryContent({ entry }: { entry: MenuAction | MenuSubmenu }) {
  return (
    <>
      <span className="menu__icon">{entry.icon}</span>
      <span className="menu__text">
        <span className="menu__label">{entry.label}</span>
        {entry.description ? <span className="menu__description">{entry.description}</span> : null}
      </span>
      {entry.hint ? <span className="menu__hint">{entry.hint}</span> : null}
    </>
  );
}

export function Menu({
  label,
  icon,
  entries,
  className,
  placement = 'top-start',
  onOpenChange,
  triggerRef: externalTriggerRef,
  showLabel,
  popupClassName,
  collapsedKeys,
  onToggleGroup,
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

  /*
   * The collapse animation's two halves. `collapsedKeys` is the caller's truth and arrives
   * the instant the toggle is clicked; `exiting` is this menu's choreography — the set of
   * families whose rows are still riding the shrinking body down. One effect turns newly
   * closed keys into exiting ones; the other unmounts them once the exit has had its time.
   * Re-expanding inside the window needs no special case: the rows are already mounted, and
   * losing `data-collapsed` restarts their animation as an entrance.
   */
  const [exiting, setExiting] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const prevCollapsedRef = useRef<ReadonlySet<string>>(EMPTY_KEYS);

  useEffect(() => {
    const now = collapsedKeys ?? EMPTY_KEYS;
    const prev = prevCollapsedRef.current;
    prevCollapsedRef.current = now;
    if (!onToggleGroup) return;
    const newlyCollapsed = [...now].filter((key) => !prev.has(key));
    if (newlyCollapsed.length === 0) return;
    setExiting((current) => new Set([...current, ...newlyCollapsed]));
  }, [collapsedKeys, onToggleGroup]);

  useEffect(() => {
    if (exiting.size === 0) return;
    const timer = window.setTimeout(() => setExiting(EMPTY_KEYS), GROUP_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  // The enabled items, in order. Queried from the DOM rather than kept in a ref array:
  // the entries are data, so the rendered list is already the only ordering that matters.
  const items = useCallback((): HTMLButtonElement[] => {
    const found = popupRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    if (!found) return [];
    // Flyout items belong to their own menu; the parent's roving focus stays on the parent.
    // A collapsing family keeps its rows mounted through the exit animation, so the second
    // filter is what makes them hold no focus slot — the same as unmounted rows. It matches
    // the group's *body*, not the group: the header sits outside the body and stays a focus
    // stop, or ArrowDown from a collapsed family would jump back to the top of the menu.
    return [...found].filter(
      (item) =>
        item.closest('[role="menu"]') === popupRef.current &&
        !item.closest('.menu__group[data-collapsed] .menu__group-body'),
    );
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
        const active = document.activeElement as HTMLElement | null;
        // Opens the flyout of the submenu under focus, the keyboard's hover.
        const submenuKey = active?.getAttribute?.('data-submenu-key');
        if (submenuKey) {
          const entry = entries.find(
            (candidate): candidate is MenuSubmenu =>
              isSubmenu(candidate) && keyOf(candidate) === submenuKey,
          );
          if (!entry || entry.disabled) break;
          event.preventDefault();
          openSubmenu(entry, active?.parentElement ?? null, true);
          break;
        }
        // Right re-opens a collapsed family — the tree-view convention, and the only way a
        // keyboard user can open one back up, since the only toggle is the header itself.
        const expandKey = active?.getAttribute?.('data-group-key');
        if (expandKey && onToggleGroup && collapsedKeys?.has(expandKey)) {
          event.preventDefault();
          onToggleGroup(expandKey);
        }
        break;
      }
      case 'ArrowLeft': {
        // Left shuts the family under focus, mirroring the flyout's ArrowLeft.
        const collapseKey = (document.activeElement as HTMLElement | null)?.getAttribute?.(
          'data-group-key',
        );
        if (collapseKey && onToggleGroup && !collapsedKeys?.has(collapseKey)) {
          event.preventDefault();
          onToggleGroup(collapseKey);
        }
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

  function renderAction(entry: MenuAction, index: number) {
    return (
      <button
        type="button"
        key={keyOf(entry)}
        role="menuitem"
        className="menu__item"
        style={indexStyle(index)}
        data-danger={entry.danger || undefined}
        disabled={entry.disabled}
        title={entry.disabled ? entry.disabledReason : undefined}
        // -1 because focus is driven by the arrow keys, not the tab order.
        tabIndex={-1}
        onClick={() => select(entry)}
      >
        <EntryContent entry={entry} />
      </button>
    );
  }

  /** A family is collapsed only when the caller opted into toggling and listed it. */
  function isCollapsed(header: MenuHeader): boolean {
    return Boolean(onToggleGroup && collapsedKeys?.has(keyOf(header)));
  }

  /**
   * The family eyebrow. With no toggle handler it stays the inert label it has always been;
   * with one it becomes a real `menuitem`, so the arrow keys can reach it — the toggle has
   * to live on the header, or a keyboard user would have no way to re-open a closed family.
   */
  function renderHeader(header: MenuHeader, index: number) {
    const style = indexStyle(index);
    if (!onToggleGroup) {
      return (
        <div className="menu__header" style={style}>
          {header.label}
        </div>
      );
    }

    const key = keyOf(header);
    return (
      <button
        type="button"
        role="menuitem"
        className="menu__header menu__header--toggle"
        style={style}
        data-group-key={key}
        aria-expanded={!isCollapsed(header)}
        tabIndex={-1}
        onClick={() => onToggleGroup(key)}
      >
        <ChevronIcon className="menu__header-chevron" />
        <span className="menu__header-label">{header.label}</span>
      </button>
    );
  }

  function renderEntry(entry: MenuAction | MenuSubmenu, index: number) {
    if (isSubmenu(entry)) {
      const isOpen = openKey === keyOf(entry);
      return (
        <div key={keyOf(entry)} className="menu__item-wrap" style={indexStyle(index)}>
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
            <EntryContent entry={entry} />
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

    return renderAction(entry, index);
  }

  return (
    <Popover
      label={label}
      icon={icon}
      triggerText={showLabel ? label : undefined}
      open={open}
      onOpenChange={setOpenState}
      className={`menu${className ? ` ${className}` : ''}`}
      popupClassName={popupClassName ? `${popupClassName} menu__popup` : 'menu__popup'}
      placement={placement}
      role="menu"
      triggerRef={triggerRef}
      popupRef={popupRef}
      onKeyDown={onKeyDown}
    >
      {groupMenuEntries(entries).map((group, groupIndex) => {
        // <hr> rather than a div with role="separator": the role is implicit, and a
        // div carrying it explicitly is expected to be focusable (a splitter).
        if (group.separator) {
          // biome-ignore lint/suspicious/noArrayIndexKey: separators carry no identity
          return <hr className="menu__separator" key={`sep-${groupIndex}`} />;
        }

        const collapsed = group.header ? isCollapsed(group.header) : false;
        // Rows stay mounted while a closing family rides its exit animation; `exiting` is
        // cleared by the timer, and only then does a collapsed group hold nothing.
        const showEntries = !collapsed || (group.header ? exiting.has(keyOf(group.header)) : false);
        let slot = 0;
        return (
          <div
            className="menu__group"
            key={group.header ? keyOf(group.header) : `group-${groupIndex}`}
            data-hue={group.header?.hue || undefined}
            data-collapsed={collapsed || undefined}
          >
            {group.header ? renderHeader(group.header, slot++) : null}
            <div className="menu__group-body">
              <div className="menu__group-inner">
                {showEntries ? group.entries.map((entry) => renderEntry(entry, slot++)) : null}
              </div>
            </div>
          </div>
        );
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
        {groupMenuEntries(entry.entries).map((group, groupIndex) => {
          // biome-ignore lint/suspicious/noArrayIndexKey: separators carry no identity
          if (group.separator) return <hr className="menu__separator" key={`sep-${groupIndex}`} />;

          return (
            <div
              className="menu__group"
              key={group.header ? keyOf(group.header) : `group-${groupIndex}`}
              data-hue={group.header?.hue || undefined}
            >
              {group.header ? <div className="menu__header">{group.header.label}</div> : null}
              {group.entries.map((child) => (isSubmenu(child) ? null : renderFlyoutAction(child)))}
            </div>
          );
        })}
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
        <EntryContent entry={child} />
      </button>
    );
  }
}
