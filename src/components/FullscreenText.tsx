/**
 * The one sanctioned overlay: long prompt text is unreadable in a 380px panel, so long
 * fields get an expanded editor. It takes the chat column, not the viewport — the top
 * bar and the side panels stay visible and usable, like SillyTavern's maximized drawer.
 *
 * Portaled into .shell as a grid item in the chat column's cell, which is what lets the
 * grid size it and carry the panel-open animation for free: no measuring, no resize
 * listeners, and the column it replaces is exactly what it covers.
 *
 * Not modal: the textarea is bound to the same value/onChange as the inline field, so
 * every close path is lossless by construction, and nothing else in the app needs to be
 * inert while it is open.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, ShrinkIcon } from '../layout/icons.tsx';
import './FullscreenText.css';

interface FullscreenTextProps {
  /** Names the overlay and its textarea. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Same semantics as TextField's hint; rendered under the textarea. */
  hint?: string;
  /**
   * Called when the overlay closes (Escape, shrink, or Close). Receives the element that
   * opened it, so focus can go back there. May be stale/unmounted — guard with isConnected.
   */
  onClose: (opener: HTMLElement | null) => void;
}

export function FullscreenText({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  hint,
  onClose,
}: FullscreenTextProps) {
  const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [shell] = useState(() => document.querySelector('.shell'));

  // Capture the opener on mount (the trigger button still holds focus), focus the editor.
  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  // Escape closes — keyboard users need a way out that does not require aiming.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose(openerRef.current);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The overlay only exists while a shell is up, so a null target is a teardown race —
  // render nothing rather than crash. The trigger stays mounted either way.
  if (!shell) return null;

  return createPortal(
    <div className="fullscreen-text" role="dialog" aria-modal="false" aria-label={label}>
      <div className="fullscreen-text__bar">
        <h2 className="fullscreen-text__title">{label}</h2>
        <div className="fullscreen-text__actions">
          <button
            type="button"
            className="wc-button wc-button--ghost"
            title="Back to the field"
            aria-label={`Close full-screen editing of ${label}`}
            onClick={() => onClose(openerRef.current)}
          >
            <ShrinkIcon />
          </button>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            title="Close"
            aria-label={`Close ${label}`}
            onClick={() => onClose(openerRef.current)}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        className="wc-textarea fullscreen-text__editor"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="fullscreen-text__hint">{hint}</p> : null}
    </div>,
    shell,
  );
}
