/**
 * The cue composer, with live macros.
 *
 * A probe is not a form value. It is a line of roleplay — `*I say nothing, and wait for
 * {{char}} to break the silence.*` — and the macros in it are the reason the same cue can be
 * drawn against forty different cards. Rendering that as undifferentiated grey text in a
 * `<textarea>` hides the one part of it that does any work.
 *
 * A textarea cannot carry markup, so this is the mirror trick: a highlighted copy of the
 * text painted underneath, and the real control on top with transparent glyphs and a visible
 * caret. The two only stay aligned if they wrap identically, which is why every metric that
 * affects wrapping is set once on a shared class rather than on each of them
 * (`.arena-cue__text` in ArenaShell.css) — a padding change on one and not the other is how
 * this technique fails, and it fails silently.
 */

import { useCallback, useLayoutEffect, useRef } from 'react';

interface CueFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter, unless Shift is held. */
  onSubmit: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * `{{char}}`, `{{user}}`, `{{random:a,b}}` — anything the assembler will expand. Exported
 * for the example-cue picker, which highlights macros in cue text the same way.
 */
export const MACRO_PARTS = /(\{\{[^{}]*\}\})/g;
/*
 * A separate, un-flagged pattern for the per-part test. `RegExp.test` on a /g regex advances
 * its own `lastIndex`, so reusing the split pattern here would return true and false
 * alternately down the same array and highlight every other macro.
 */
export const IS_MACRO = /^\{\{[^{}]*\}\}$/;

export function CueField({
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 3,
  disabled = false,
  ariaLabel = 'Cue',
}: CueFieldProps) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /*
   * The caret position captured in onChange, re-applied by the layout effect below. Pool cues
   * autosave every keystroke: the save round-trip returns a rebuilt probes array (server-side
   * `normalizeProbes`), `setSettings` hands this field a fresh `value` prop, and React's
   * controlled-textarea update resets the caret to the end of the line when it writes that
   * value back. The text is identical, so the only visible damage is the caret — capture it
   * at the moment of the edit and put it back once React has finished writing.
   */
  const caretRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret === null) return;
    caretRef.current = null;
    const input = inputRef.current;
    if (!input || document.activeElement !== input) return;
    if (input.selectionStart !== caret) input.setSelectionRange(caret, caret);
  });

  const syncScroll = useCallback((element: HTMLTextAreaElement) => {
    const mirror = mirrorRef.current;
    if (mirror) mirror.scrollTop = element.scrollTop;
  }, []);

  return (
    <div className="arena-cue__field">
      <div className="arena-cue__text arena-cue__mirror" ref={mirrorRef} aria-hidden="true">
        {value.split(MACRO_PARTS).map((part, index) =>
          // The split is stable for a given string and the parts have no identity of their
          // own, so the index is the only key available — and the correct one.
          IS_MACRO.test(part) ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: text runs have no other identity
            <mark key={index} className="arena-cue__macro">
              {part}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: text runs have no other identity
            <span key={index}>{part}</span>
          ),
        )}
        {/*
         * A trailing newline has no height of its own in a block, so without this the mirror
         * is one line shorter than the textarea the moment you press Enter at the end.
         */}
        {value.endsWith('\n') ? ' ' : null}
      </div>

      <textarea
        ref={inputRef}
        className="arena-cue__text arena-cue__input"
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={(event) => {
          // Capture the caret *after* this keystroke has been applied — that is the position
          // the layout effect restores once React rewrites the value on the autosave echo.
          caretRef.current = event.target.selectionStart;
          onChange(event.target.value);
        }}
        onScroll={(event) => syncScroll(event.currentTarget)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line — the composer's bargain, because a cue
          // is one or two lines and reaching for a button every time is friction in the loop
          // this screen exists to make fast.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}
