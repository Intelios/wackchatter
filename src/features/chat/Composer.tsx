import { type ReactNode, useEffect, useRef, useState } from 'react';
import { SendIcon, StopIcon } from '../../layout/icons.tsx';

const MAX_ROWS = 12;

interface ComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  /**
   * Rendered before the input. A slot rather than a concrete menu so the composer stays
   * ignorant of the chat hook.
   */
  leading?: ReactNode;
}

export function Composer({ onSend, onStop, busy, disabled, placeholder, leading }: ComposerProps) {
  const [text, setText] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

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
