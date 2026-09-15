/**
 * A popup anchored to a trigger button.
 *
 * The shell only: open/close, the flip when the preferred side has no room, dismissal, and
 * the ARIA wiring. What goes inside is the caller's business — `Menu` puts a list of
 * actions in it, `GuidesPopover` puts a form.
 *
 * Extracted from `Menu` rather than written alongside it. The dismissal and flip rules are
 * subtle enough that a second copy would drift, and the drift would be invisible until
 * someone found a popup they could not reach.
 *
 * Non-modal on purpose, like `Menu` was: the chat behind it stays live and usable, per the
 * UI conventions, and there is no focus trap. Controlled, because the two consumers both
 * need to close it from inside their own content.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import './Popover.css';

/**
 * Props handed to a custom trigger rendered via `renderTrigger`.
 *
 * Spread these onto the element that should act as the trigger, then add the element's own
 * props (value, onChange, onFocus…). The `ref` callback is what lets `Popover` measure the
 * trigger for the flip and restore focus to it on Escape — it must land on the focusable
 * element, not a wrapper.
 */
export interface PopoverTriggerProps {
  ref: (node: HTMLElement | null) => void;
  'aria-haspopup': 'menu' | 'dialog' | 'listbox';
  'aria-expanded': boolean;
  'aria-controls'?: string;
  'aria-label'?: string;
  title: string;
  disabled?: boolean;
}

/**
 * Which corner the popup grows from. `top-start` is the composer's buttons, which open
 * upward because they sit at the bottom of the chat column; `bottom-end` is a trigger in
 * the top-right of something, like a message bubble's overflow.
 */
export type PopoverPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

interface PopoverProps {
  /** Accessible name for the trigger, and its tooltip. */
  label: string;
  icon: ReactNode;
  /** Rendered over the trigger's corner — an active count, say. */
  badge?: ReactNode;
  /** Optional visible text beside the trigger icon. */
  triggerText?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  popupClassName?: string;
  placement?: PopoverPlacement;
  /** `menu` for a list of actions, `dialog` for content with its own controls, `listbox`
   * for a combobox's option list. */
  role?: 'menu' | 'dialog' | 'listbox';
  disabled?: boolean;
  /** Why it is disabled. Becomes the title, so a greyed trigger still explains itself. */
  disabledReason?: string;
  /** Forwarded so a caller can drive focus inside the popup, or restore it to the trigger. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  popupRef?: RefObject<HTMLDivElement | null>;
  /** Extra key handling on the root. Escape is already taken care of. */
  onKeyDown?: (event: ReactKeyboardEvent) => void;
  /**
   * Render a custom trigger instead of the built-in button. Receives the props to spread
   * onto the focusable element so the popup still wires up `aria-haspopup`,
   * `aria-expanded`, `aria-controls`, the tooltip and disabled state, plus a `ref` callback
   * that feeds the flip measurement and Escape focus-restore. The trigger is responsible
   * for opening the popup itself (e.g. on focus or click) by calling `onOpenChange`.
   */
  renderTrigger?: (props: PopoverTriggerProps) => ReactNode;
}

export function Popover({
  label,
  icon,
  badge,
  triggerText,
  open,
  onOpenChange,
  children,
  className,
  popupClassName,
  placement = 'top-start',
  role = 'dialog',
  disabled,
  disabledReason,
  triggerRef: externalTriggerRef,
  popupRef: externalPopupRef,
  onKeyDown,
  renderTrigger,
}: PopoverProps) {
  const [flipped, setFlipped] = useState(false);
  const [alignFlipped, setAlignFlipped] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // `HTMLElement` rather than `HTMLButtonElement`: a custom trigger (via `renderTrigger`)
  // may be an `<input>`, and the flip measurement + focus-restore only need a generic node.
  const ownTriggerRef = useRef<HTMLElement | null>(null);
  const ownPopupRef = useRef<HTMLDivElement>(null);
  const triggerRef = (externalTriggerRef as RefObject<HTMLElement | null>) ?? ownTriggerRef;
  const popupRef = externalPopupRef ?? ownPopupRef;

  const [side, align] = placement.split('-') as ['top' | 'bottom', 'start' | 'end'];
  const effectiveSide = flipped ? (side === 'top' ? 'bottom' : 'top') : side;
  const effectiveAlign = alignFlipped ? (align === 'start' ? 'end' : 'start') : align;

  /*
   * Flip when the preferred side has no room.
   *
   * Without this, a bubble's ⋯ near the bottom of the window opens a popup that runs off
   * the screen — the last entries, delete among them, simply cannot be reached. CSS cannot
   * measure that, so this does, in a layout effect so the flip lands before paint.
   *
   * A flip rather than a portal: the popup stays a child of the root, which keeps the
   * dismissal and focus handling working on ordinary DOM containment.
   */
  useLayoutEffect(() => {
    if (!open) {
      setFlipped(false);
      setAlignFlipped(false);
      return;
    }

    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;

    const rect = trigger.getBoundingClientRect();

    // Room measured inside the nearest ancestor that would clip us — the chat column for
    // every popup in this app. Viewport-based numbers overestimate by the height of the
    // top bar, and a popup taller than its clipping box is not scrolled, just cut off.
    let topBound = 0;
    let bottomBound = window.innerHeight;
    let leftBound = 0;
    let rightBound = window.innerWidth;
    for (let node = popup.parentElement; node; node = node.parentElement) {
      if (getComputedStyle(node).overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      topBound = box.top;
      bottomBound = box.bottom;
      leftBound = box.left;
      rightBound = box.right;
      break;
    }

    const roomAbove = rect.top - topBound;
    const roomBelow = bottomBound - rect.bottom;
    const needed = popup.offsetHeight + 4;

    // Only flip if the other side is genuinely better — flipping into an equally bad spot
    // just moves the problem.
    const flip =
      side === 'top'
        ? roomAbove < needed && roomBelow > roomAbove
        : roomBelow < needed && roomAbove > roomBelow;
    setFlipped(flip);

    const roomFromStart = rightBound - rect.left;
    const roomFromEnd = rect.right - leftBound;
    setAlignFlipped(
      align === 'start'
        ? popup.offsetWidth > roomFromStart && roomFromEnd > roomFromStart
        : popup.offsetWidth > roomFromEnd && roomFromStart > roomFromEnd,
    );

    // Grow with the content, but never past the room on the side we open on — past that
    // the clipping ancestor cuts the popup off, so it scrolls instead. A stylesheet cap
    // (min(60vh, --wc-scroll-cap) by default) still governs where one is set; the menu
    // overrides it to `none` and is bounded by the room alone.
    const room =
      (side === 'top' ? (flip ? roomBelow : roomAbove) : flip ? roomAbove : roomBelow) - 8;
    const cssCap = Number.parseFloat(getComputedStyle(popup).maxHeight);
    const limit = Number.isFinite(cssCap) ? Math.min(cssCap, room) : room;
    popup.style.maxHeight = `${Math.max(limit, 100)}px`;
  }, [open, side, align, triggerRef, popupRef]);

  // Dismiss on a click anywhere outside. `pointerdown` rather than `click` so the popup is
  // gone before the click lands on whatever is underneath.
  //
  // No focus restore on this path, unlike Escape: the click has already put focus
  // somewhere the user chose, and pulling it back to the trigger would fight them.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onOpenChange]);

  function handleKeyDown(event: ReactKeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onOpenChange(false);
      // Put focus back where it started, so keyboard users are not stranded — but one
      // tick later, after the close has rendered. The close is a batched state update,
      // so the popup's content is still mounted at this instant and focusing the trigger
      // now would blur whatever holds focus inside it; a field that commits on blur (the
      // rename form) would commit the edit Escape was discarding. Once unmounted, no
      // blur fires at all — removing a focused element from the DOM is silent.
      window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
      return;
    }
    onKeyDown?.(event);
  }

  const popupProps = {
    className: `popover__popup${popupClassName ? ` ${popupClassName}` : ''}`,
    id,
    ref: popupRef,
    onKeyDown: handleKeyDown,
  };

  return (
    <div
      className={`popover${className ? ` ${className}` : ''}`}
      data-side={effectiveSide}
      data-align={effectiveAlign}
      ref={rootRef}
    >
      {renderTrigger ? (
        renderTrigger({
          ref: (node: HTMLElement | null) => {
            ownTriggerRef.current = node;
          },
          'aria-haspopup': role,
          'aria-expanded': open,
          'aria-controls': open ? id : undefined,
          'aria-label': label,
          title: disabled ? (disabledReason ?? label) : label,
          disabled,
        })
      ) : (
        <button
          type="button"
          ref={triggerRef as RefObject<HTMLButtonElement | null>}
          className="wc-button wc-button--ghost popover__trigger"
          aria-haspopup={role}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={label}
          title={disabled ? disabledReason : label}
          disabled={disabled}
          onClick={() => onOpenChange(!open)}
        >
          {icon}
          {triggerText ? <span>{triggerText}</span> : null}
          {badge}
        </button>
      )}

      {open ? (
        role === 'menu' ? (
          <div {...popupProps} role="menu" aria-label={label}>
            {children}
          </div>
        ) : role === 'listbox' ? (
          <div {...popupProps} role="listbox" aria-label={label}>
            {children}
          </div>
        ) : (
          <div {...popupProps} role="dialog" aria-label={label}>
            {children}
          </div>
        )
      ) : null}
    </div>
  );
}
