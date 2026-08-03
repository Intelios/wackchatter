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
      return;
    }

    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;

    const rect = trigger.getBoundingClientRect();
    const needed = popup.offsetHeight + 4;
    const roomAbove = rect.top;
    const roomBelow = window.innerHeight - rect.bottom;

    // Only flip if the other side is genuinely better — flipping into an equally bad spot
    // just moves the problem.
    setFlipped(
      side === 'top'
        ? roomAbove < needed && roomBelow > roomAbove
        : roomBelow < needed && roomAbove > roomBelow,
    );
  }, [open, side, triggerRef, popupRef]);

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
      // Put focus back where it started, so keyboard users are not stranded.
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    onKeyDown?.(event);
  }

  return (
    <div
      className={`popover${className ? ` ${className}` : ''}`}
      data-side={effectiveSide}
      data-align={align}
      ref={rootRef}
      onKeyDown={handleKeyDown}
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
          {badge}
        </button>
      )}

      {open ? (
        <div
          className={`popover__popup${popupClassName ? ` ${popupClassName}` : ''}`}
          id={id}
          ref={popupRef}
          role={role}
          aria-label={label}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
