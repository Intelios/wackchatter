import { useEffect, useRef, useState } from 'react';
import { SendIcon, StopIcon } from '../../layout/icons.tsx';

const MAX_ROWS = 12;

interface ComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
}

export function Composer({ onSend, onStop, busy, disabled, placeholder }: ComposerProps) {
  const [text, setText] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, up to a cap, then scroll internally. `text` is the trigger
  // even though the effect reads the DOM rather than the value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the resize trigger
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    const max = Number.parseFloat(getComputedStyle(element).lineHeight) * MAX_ROWS;
    element.style.height = `${Math.min(element.scrollHeight, max)}px`;
  }, [text]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    setText('');
    onSend(trimmed);
  }

  return (
    <div className="composer">
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
