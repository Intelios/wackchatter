import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { GuidedSwipeIcon, SendIcon, StopIcon, WandIcon } from '../../layout/icons.tsx';
import './Composer.css';

const MAX_ROWS = 12;

/**
 * The one write path into the composer's private draft — quick commands use it to place
 * their text ready to send. Reading the draft stays impossible, the same bargain the
 * `onSend` callbacks make.
 */
export interface ComposerHandle {
  /** Append on a new line when there is a draft, replace when there is not. */
  insert: (text: string) => void;
}

interface ComposerProps {
  onSend: (text: string) => void;
  /**
   * Guided generations. They take the text rather than reading it from a lifted state, the
   * same bargain `onSend` makes: the composer keeps owning its draft, and the chat hook
   * never learns there is a textarea.
   *
   * Absent means the button is not rendered at all, so the composer works unguided.
   */
  onGuide?: (text: string) => void;
  onGuidedSwipe?: (text: string) => void;
  /** Why guided swipe is unavailable. Becomes its title — disabled beats refused. */
  guidedSwipeDisabledReason?: string;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  /**
   * Rendered before the input. A slot rather than a concrete menu so the composer stays
   * ignorant of the chat hook.
   */
  leading?: ReactNode;
  ref?: Ref<ComposerHandle>;
}

export function Composer({
  onSend,
  onGuide,
  onGuidedSwipe,
  guidedSwipeDisabledReason,
  onStop,
  busy,
  disabled,
  placeholder,
  leading,
  ref,
}: ComposerProps) {
  const [text, setText] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      insert(added: string) {
        setText((current) => {
          const trimmed = current.trimEnd();
          return trimmed ? `${trimmed}\n${added}` : added;
        });
        // A menu selection restores focus to the menu's trigger AFTER `onSelect` runs, so
        // the focus waits one tick to win — "ready to send" means the cursor is here.
        setTimeout(() => textarea.current?.focus({ preventScroll: true }), 0);
      },
    }),
    [],
  );

  /**
   * Grow with the content, up to a cap, then scroll internally.
   *
   * Re-measured on a width change as well as on typing. That is not a nicety: a
   * measurement taken while the composer is narrow reads a `scrollHeight` far too large
   * and clamps to MAX_ROWS, and with `text` as the only trigger that wrong height then
   * sticks for the life of the component.
   */
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;

    const resize = () => {
      // Empty means exactly one row, and that needs no measuring — dropping the inline
      // height falls back to the `rows={1}` height the stylesheet gives it.
      //
      // This is the case worth special-casing rather than trusting the measurement for:
      // measured while the composer is narrow (mid-transition, or laid out inside a
      // collapsed column) the PLACEHOLDER wraps to a character per line, `scrollHeight`
      // comes back enormous, and the clamp below pins an empty composer at twelve rows
      // for the life of the component.
      if (!text) {
        element.style.height = '';
        return;
      }

      element.style.height = 'auto';
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      const max = Number.isFinite(lineHeight) ? lineHeight * MAX_ROWS : Number.POSITIVE_INFINITY;
      element.style.height = `${Math.min(element.scrollHeight, max)}px`;
    };

    resize();

    // Only on a WIDTH change. Observing height would feed back into itself, since resize
    // is what changes the height. Width is what actually invalidates the measurement: a
    // panel opening or closing, a window resize, and the 0 -> real first layout.
    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return;
      lastWidth = element.clientWidth;
      resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    setText('');
    onSend(trimmed);
  }

  /**
   * Guided actions deliberately leave the text where it is.
   *
   * It is not your turn — it is an instruction — so there is nothing to "send away", and
   * keeping it is what makes "guide, then guide the swipe the same way" one retype rather
   * than two. The extension this is modelled on clears the box and then needs a whole
   * Recover Input button to undo that; losing typed text with no way back is worse than
   * leaving it visible.
   */
  function guided(action: (text: string) => void) {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    action(trimmed);
  }

  return (
    <div className="composer">
      {leading}

      <textarea
        ref={textarea}
        className="composer__input"
        value={text}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is a newline.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />

      {/* Hidden mid-generation rather than disabled: Send has already become Stop, and two
          dead buttons beside it is noise where the row should read as one action. */}
      {!busy && onGuide ? (
        <button
          type="button"
          className="wc-button wc-button--ghost composer__icon"
          onClick={() => guided(onGuide)}
          disabled={disabled || !text.trim()}
          aria-label="Guide the next reply"
          title={
            text.trim()
              ? 'Guide the next reply — steers it without sending this as a message'
              : 'Type an instruction to guide the next reply'
          }
        >
          <WandIcon />
        </button>
      ) : null}

      {!busy && onGuidedSwipe ? (
        <button
          type="button"
          className="wc-button wc-button--ghost composer__icon"
          onClick={() => guided(onGuidedSwipe)}
          disabled={disabled || !text.trim() || Boolean(guidedSwipeDisabledReason)}
          aria-label="Guided swipe"
          title={
            guidedSwipeDisabledReason ??
            (text.trim()
              ? 'Guided swipe — a new alternate for the last reply, steered by this'
              : 'Type an instruction to steer a new alternate')
          }
        >
          <GuidedSwipeIcon />
        </button>
      ) : null}

      {busy ? (
        <button
          type="button"
          className="wc-button wc-button--danger composer__button"
          onClick={onStop}
          title="Stop generating"
        >
          <StopIcon />
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="wc-button wc-button--primary composer__button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          title="Send (Enter)"
        >
          <SendIcon />
          Send
        </button>
      )}
    </div>
  );
}
