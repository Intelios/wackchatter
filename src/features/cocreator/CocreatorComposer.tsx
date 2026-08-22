import type { QuickCommand } from '@shared/types/settings.ts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SendIcon, StopIcon } from '../../layout/icons.tsx';
import { composerMaxHeight, rowCap } from '../chat/composerGrowth.ts';
import { CocreatorQuickCommands } from './CocreatorQuickCommands.tsx';

interface CocreatorComposerProps {
  busy: boolean;
  blockedReason: string | null;
  /**
   * Send the draft. The composer keeps owning it, the same bargain the chat composer makes
   * with its `onSend` — the desk never learns there is a textarea.
   */
  onSend: (text: string) => void;
  onStop: () => void;
  quickCommands: QuickCommand[];
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
}

/**
 * The Co-Creator's message box.
 *
 * Grows with its content like the chat composer, so a long design brief is readable
 * instead of a three-row letterbox: the box expands upward to the same two ceilings
 * (`rowCap` rows, or the viewport share) and scrolls internally past whichever is lower.
 */
export function CocreatorComposer({
  busy,
  blockedReason,
  onSend,
  onStop,
  quickCommands,
  onQuickCommandsChange,
}: CocreatorComposerProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The box is the only thing on this screen you can do anything with on arrival.
  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  /** A quick-command pick appends to the draft and hands the box back, ready to send. */
  const insertQuickCommand = useCallback((text: string) => {
    setDraft((current) => {
      const trimmed = current.trimEnd();
      return trimmed ? `${trimmed}\n${text}` : text;
    });
    // A menu selection restores focus to the menu's trigger AFTER `onSelect` runs, so the
    // focus waits one tick to win — "ready to send" means the cursor is here.
    setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
  }, []);

  function submit() {
    const text = draft.trim();
    if (!text || busy || blockedReason) return;
    setDraft('');
    onSend(text);
  }

  /**
   * Grow with the content, up to a cap, then scroll internally.
   *
   * Re-measured on a width change as well as on typing, for the reason Composer.tsx
   * documents: a measurement taken while the box is narrow reads a `scrollHeight` far too
   * large and clamps to the row cap, and with `draft` as the only trigger that wrong
   * height then sticks for the life of the component.
   */
  useLayoutEffect(() => {
    const element = textareaRef.current;
    const root = rootRef.current;
    if (!element || !root) return;

    /**
     * Everything in the composer that is not the input: the row's padding, plus the
     * buttons' excess while the input is shorter than they are.
     *
     * Measured rather than named as a constant, because it is a sum of tokens (padding,
     * control heights) and a hardcoded number would drift silently the first time one
     * moved. This is the value the viewport ceiling is charged for; see
     * `composerMaxHeight`. Reading the laid-out heights inside `resize` cannot feed back
     * the way observing the input's height would: the furniture is constant once the
     * input outgrows the buttons beside it, so the ceiling it produces settles at a fixed
     * point.
     */
    const measureFurniture = (): number => {
      const rootHeight = root.offsetHeight;
      const inputHeight = element.offsetHeight;
      if (!rootHeight || !inputHeight) return 0;
      return Math.max(0, rootHeight - inputHeight);
    };

    const resize = () => {
      // Empty means exactly the resting rows, and that needs no measuring — dropping the
      // inline height falls back to the `rows={3}` height the attribute gives it.
      //
      // Measured while the composer is narrow the PLACEHOLDER wraps to a character per
      // line, `scrollHeight` comes back enormous, and the clamp below would pin an empty
      // box at max rows for the life of the component.
      if (!draft) {
        element.style.height = '';
        return;
      }

      const style = getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const paddingTop = Number.parseFloat(style.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
      const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
      const verticalPadding = paddingTop + paddingBottom;
      const verticalBorders = borderTop + borderBottom;

      // One row, as base.css defines it: `min-height` on `.wc-textarea`. The floor comes
      // from the same stylesheet that sizes the box, never from a number retyped here.
      const oneRow =
        Number.parseFloat(style.minHeight) || lineHeight + verticalPadding + verticalBorders || 0;

      // The visual viewport, where there is one: with a phone keyboard up it is the part
      // of the window still visible, which is the height the composer actually has to fit.
      const viewportHeight = globalThis.visualViewport?.height ?? globalThis.innerHeight;
      const maxHeight = composerMaxHeight({
        rowCap: rowCap({ lineHeight, verticalPadding, verticalBorders }),
        viewportHeight,
        trayBlock: measureFurniture(),
        rowHeight: oneRow,
      });

      const prevScrollTop = element.scrollTop;
      element.style.height = 'auto';

      const targetHeight = Math.min(element.scrollHeight + verticalBorders, maxHeight);
      element.style.height = `${targetHeight}px`;

      // Restore scroll position or follow the caret.
      if (document.activeElement === element) {
        const isNearEnd = element.selectionEnd === null || element.selectionEnd >= draft.length - 1;
        if (isNearEnd) {
          element.scrollTop = element.scrollHeight;
        } else {
          element.scrollTop = prevScrollTop;
        }
      } else {
        element.scrollTop = prevScrollTop;
      }
    };

    resize();

    // Only on a WIDTH change. Observing height would feed back into itself, since resize
    // is what changes the height. Width is what actually invalidates the measurement: the
    // column the desk gives the composer, and the 0 -> real first layout.
    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return;
      lastWidth = element.clientWidth;
      resize();
    });
    observer.observe(element);

    // The viewport ceiling moves with the window, and a height-only resize changes neither
    // the textarea's width nor its content — so nothing above would re-measure for it.
    globalThis.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      globalThis.removeEventListener('resize', resize);
    };
  }, [draft]);

  return (
    <div className="cocreator-composer" ref={rootRef}>
      <CocreatorQuickCommands
        quickCommands={quickCommands}
        onInsertCommand={insertQuickCommand}
        onQuickCommandsChange={onQuickCommandsChange}
      />
      <textarea
        ref={textareaRef}
        className="wc-textarea cocreator-composer__input"
        value={draft}
        rows={3}
        placeholder={
          blockedReason
            ? `${blockedReason}. Open Connections from the chat screen to set one up.`
            : 'Describe the character, or ask for a first message…'
        }
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter is a newline — the composer's convention app-wide.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {busy ? (
        <button
          type="button"
          className="wc-button wc-button--danger cocreator-composer__send"
          onClick={onStop}
          title="Stop generating"
        >
          <StopIcon />
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="wc-button wc-button--primary cocreator-composer__send"
          onClick={submit}
          disabled={!draft.trim() || Boolean(blockedReason)}
          title={blockedReason ?? 'Send'}
        >
          <SendIcon />
          Send
        </button>
      )}
    </div>
  );
}
