/**
 * The `{{` completion box.
 *
 * Macros are the app's least discoverable feature: forty of them, spelled exactly or not at
 * all, and until now the only way to learn one was to read `macros.ts`. This is the fix —
 * type two braces anywhere a macro is allowed and the list comes to you.
 *
 * A hook plus a listbox rather than a wrapped textarea, because the two hosts are not alike:
 * the composer's field carries a slash box, a growth measurement and a send action already,
 * and `TextField` is a shared control that must not grow a chat feature's assumptions. Both
 * keep their own textarea and call four small functions.
 *
 * Recognition lives in `macroCompletion.ts`, where a test can reach it.
 */

import { MACRO_CATEGORY_LABELS, type MacroDoc } from '@shared/prompt/macroCatalog.ts';
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { macroCompletion, macroInsertion } from './macroCompletion.ts';
import './MacroCompletion.css';

export interface MacroCompletionHandle {
  open: boolean;
  suggestions: MacroDoc[];
  activeIndex: number;
  listboxId: string;
  listboxRef: RefObject<HTMLDivElement | null>;
  accept: (macro: MacroDoc) => void;
  /** Consumes the key when the box is open. Returns true when the host should stop. */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
  /** Call whenever the text or the caret may have moved. */
  sync: () => void;
  /** Call on blur. Typing re-opens the box. */
  dismiss: () => void;
}

interface UseMacroCompletionOptions {
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  enabled?: boolean;
}

export function useMacroCompletion({
  value,
  onChange,
  textareaRef,
  enabled = true,
}: UseMacroCompletionOptions): MacroCompletionHandle {
  const listboxId = useId();
  const listboxRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  /*
   * Where the caret goes once React has written the accepted text.
   *
   * Setting it during `accept` would put the caret in the middle of the OLD value, and the
   * controlled re-render would then throw it to the end of the new one. It has to wait for
   * the commit, which is what the layout effect below is.
   */
  const pendingCaret = useRef<number | null>(null);

  const completion = enabled && !dismissed ? macroCompletion(value, caret) : null;
  const suggestions = completion?.suggestions ?? [];
  const open = suggestions.length > 0;
  const activeIndex = open ? Math.min(index, suggestions.length - 1) : -1;

  const sync = useCallback(() => {
    setDismissed(false);
    setIndex(0);
    setCaret(textareaRef.current?.selectionStart ?? 0);
  }, [textareaRef]);

  const dismiss = useCallback(() => setDismissed(true), []);

  const accept = useCallback(
    (macro: MacroDoc) => {
      const context = macroCompletion(value, caret);
      if (!context) return;
      const inserted = macroInsertion(value, context, macro);
      pendingCaret.current = inserted.caret;
      setIndex(0);
      onChange(inserted.text);
    },
    [value, caret, onChange],
  );

  // `value` is the trigger, not an input: the caret can only be placed once the new text
  // has been written to the DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the trigger
  useLayoutEffect(() => {
    const target = pendingCaret.current;
    if (target === null) return;
    pendingCaret.current = null;
    const element = textareaRef.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(target, target);
    setCaret(target);
  }, [value, textareaRef]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (!open) return false;
      const active = suggestions[activeIndex];

      // Enter and Tab both accept. Enter would otherwise send the message or insert a line
      // break — picking a macro is what the box is on screen for.
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && active) {
        event.preventDefault();
        accept(active);
        return true;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setIndex((current) => (current + 1) % suggestions.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return true;
      }
      return false;
    },
    [open, suggestions, activeIndex, accept],
  );

  // Keep the highlighted option visible when the list overflows its cap.
  useLayoutEffect(() => {
    if (!open) return;
    const listbox = listboxRef.current;
    const option = listbox?.children[activeIndex] as HTMLElement | undefined;
    if (!listbox || !option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < listbox.scrollTop) listbox.scrollTop = top;
    else if (bottom > listbox.scrollTop + listbox.clientHeight) {
      listbox.scrollTop = bottom - listbox.clientHeight;
    }
  }, [open, activeIndex]);

  return {
    open,
    suggestions,
    activeIndex,
    listboxId,
    listboxRef,
    accept,
    handleKeyDown,
    sync,
    dismiss,
  };
}

/** Props for the host's textarea, so the two hosts cannot describe the box differently. */
export function macroComboboxProps(handle: MacroCompletionHandle) {
  const active = handle.suggestions[handle.activeIndex];
  return {
    role: 'combobox' as const,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': handle.open,
    'aria-controls': handle.open ? handle.listboxId : undefined,
    'aria-activedescendant': active ? `${handle.listboxId}-${optionId(active)}` : undefined,
  };
}

/** `//` is a legal macro name and an illegal chunk of an id. */
function optionId(macro: MacroDoc): string {
  return macro.name === '//' ? 'comment' : macro.name;
}

interface MacroCompletionListProps {
  handle: MacroCompletionHandle;
  /** Which way the box grows. The composer's field has no room below it. */
  placement?: 'above' | 'below';
}

export function MacroCompletionList({ handle, placement = 'above' }: MacroCompletionListProps) {
  /*
   * Flip when the requested side does not fit.
   *
   * Not a nicety: the prompt editor's Content field is twelve rows tall inside a scrolling
   * panel, so "below the field" is reliably a hundred-odd pixels past the bottom of the
   * window — the box renders correctly and nobody ever sees it.
   *
   * Written straight to the DOM rather than held in state, because this runs on every
   * render while the box is open and a `setState` here is a loop waiting to happen. A
   * layout effect lands before paint, so the measured side is never the painted one.
   */
  useLayoutEffect(() => {
    const box = handle.listboxRef.current;
    if (!box) return;
    box.dataset.placement = placement;
    const rect = box.getBoundingClientRect();
    const fits = placement === 'below' ? rect.bottom <= window.innerHeight : rect.top >= 0;
    if (!fits) box.dataset.placement = placement === 'below' ? 'above' : 'below';
  });

  if (!handle.open) return null;

  return (
    <div
      ref={handle.listboxRef}
      id={handle.listboxId}
      className="wc-macro-box"
      data-placement={placement}
      role="listbox"
      aria-label="Macros"
    >
      {handle.suggestions.map((macro, index) => {
        const active = index === handle.activeIndex;
        return (
          <button
            type="button"
            key={macro.name}
            id={`${handle.listboxId}-${optionId(macro)}`}
            role="option"
            aria-selected={active}
            className={`wc-macro-item${active ? ' wc-macro-item--active' : ''}`}
            tabIndex={-1}
            // Keep the field focused so the draft keeps receiving input — the ordinary
            // combobox trick, without which a click would blur the box shut.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => handle.accept(macro)}
          >
            <span className="wc-macro-name">{macro.usage}</span>
            <span className="wc-macro-desc">{macro.description}</span>
            <span className="wc-macro-cat">{MACRO_CATEGORY_LABELS[macro.category]}</span>
          </button>
        );
      })}
    </div>
  );
}
