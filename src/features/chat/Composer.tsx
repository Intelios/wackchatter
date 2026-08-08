import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { GuidedSwipeIcon, SendIcon, StopIcon, WandIcon } from '../../layout/icons.tsx';
import { type SlashCommandHelp, slashCompletion } from './slashCommands.ts';
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
  /**
   * Send the text, or take it as a slash command.
   *
   * Resolves `null` when the text was accepted (clears the draft) or an error string when
   * it was a command that failed to run (keeps the draft, shows the error). Normal
   * messages resolve quickly — the composer clears optimistically while the generation
   * itself runs; a slow `/reload` keeps the text visible until it settles.
   */
  onSend: (text: string) => Promise<string | null>;
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
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether the input is wearing its composing shape — see the morph in Composer.css.
   *
   * State rather than `:focus`, because the two states are not the same one: sending has
   * to relax the box back to neutral while the cursor is still sitting in it, and only
   * touching it again should round it back. Anything that means "I am working in here"
   * rounds it: focus, a click, a keystroke.
   */
  const [rounded, setRounded] = useState(false);
  /** Runs the one-shot settle keyframes, which override the shape transition while they play. */
  const [settling, setSettling] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  /**
   * The input that kicked off a generation, or null when the busy flag did not start
   * here — a summary from the chat menu, a regenerate from the transcript.
   *
   * The textarea is disabled while a generation runs, and a disabled element cannot hold
   * focus: the browser drops it the moment `disabled` lands, and nothing brings it back.
   * Snapshot where the user was working at the moment they sent, then on settle give the
   * input back — unless they moved to something outside the composer while waiting,
   * which is a choice to respect rather than fight.
   */
  const focusBeforeGenerate = useRef<Element | null>(null);

  useEffect(() => {
    if (busy || !focusBeforeGenerate.current) return;
    const active = document.activeElement;
    if (active === document.body || active === null || rootRef.current?.contains(active)) {
      textarea.current?.focus({ preventScroll: true });
    }
    focusBeforeGenerate.current = null;
  }, [busy]);

  /**
   * Retire the settle animation on a timer rather than on `animationend`.
   *
   * The event is the obvious hook and the wrong one: under reduced motion the animation is
   * `none`, so it never fires and the flag sticks forever. A timer past the animation's
   * length is right in both worlds.
   */
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), 520);
    return () => clearTimeout(timer);
  }, [settling]);

  // --- Slash command autocomplete -------------------------------------------

  // The highlighted option and a "closed until the text changes" flag. Visibility is
  // otherwise derived from the draft, so typing `/` is what summons the box.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const completion = slashCompletion(text);
  const suggestions = completion?.suggestions ?? [];
  const slashOpen = Boolean(
    completion && suggestions.length > 0 && !slashDismissed && !disabled && !busy,
  );
  const completing = Boolean(completion?.completing && slashOpen);
  const activeIndex = completing ? Math.min(slashIndex, suggestions.length - 1) : -1;

  /** Replace the half-typed command name with the picked command, ready for its args. */
  function completeCommand(command: SlashCommandHelp) {
    setText(`/${command.name} `);
    setError(null);
    setSlashDismissed(false);
    setSlashIndex(0);
    textarea.current?.focus({ preventScroll: true });
  }

  // Keep the highlighted option visible when the box overflows its cap.
  useLayoutEffect(() => {
    if (!slashOpen || !completing) return;
    const listbox = listboxRef.current;
    const option = listbox?.children[activeIndex] as HTMLElement | undefined;
    if (!listbox || !option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < listbox.scrollTop) {
      listbox.scrollTop = top;
    } else if (bottom > listbox.scrollTop + listbox.clientHeight) {
      listbox.scrollTop = bottom - listbox.clientHeight;
    }
  }, [slashOpen, completing, activeIndex]);

  useImperativeHandle(
    ref,
    () => ({
      insert(added: string) {
        setText((current) => {
          const trimmed = current.trimEnd();
          return trimmed ? `${trimmed}\n${added}` : added;
        });
        setSlashDismissed(false);
        setSlashIndex(0);
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

  /**
   * Send, or run as a slash command. A returned error keeps the draft — a command that
   * failed must not vanish into the ether — and is shown inline below the input.
   */
  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    // The textarea is about to be disabled, which drops focus with nowhere to hand it to.
    focusBeforeGenerate.current = document.activeElement;
    const failure = await onSend(trimmed);
    if (failure) {
      setError(failure);
      // No generation ran, so nothing disabled the input — the snapshot must not leak
      // into a later busy cycle it had nothing to do with.
      focusBeforeGenerate.current = null;
      return;
    }
    setError(null);
    // Sent: let the shape relax. A failure returns above without this, since the draft is
    // still yours to work on and the box should still look like it.
    setRounded(false);
    setSettling(true);
    // Only clear what was sent: while a slow command (reload) was still running the user
    // may have started typing the next message, and that draft is theirs to keep.
    setText((current) => (current.trim() === trimmed ? '' : current));
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
    focusBeforeGenerate.current = document.activeElement;
    action(trimmed);
  }

  return (
    <div className="composer" ref={rootRef} data-busy={busy || undefined}>
      {error ? (
        <div className="composer__error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="composer__row">
        {leading}

        <div className="composer__field">
          {slashOpen ? (
            <div
              ref={listboxRef}
              className="composer__slash"
              role="listbox"
              aria-label="Slash commands"
            >
              {suggestions.map((command, index) => {
                const active = index === activeIndex;
                return (
                  <button
                    type="button"
                    key={command.name}
                    id={`${listboxId}-${command.name}`}
                    role="option"
                    aria-selected={active}
                    data-slash-active={active || undefined}
                    className={`composer__slash-item${
                      active ? ' composer__slash-item--active' : ''
                    }`}
                    tabIndex={-1}
                    onMouseDown={(event) => {
                      // Keep the textarea focused so the draft keeps receiving input — the
                      // ordinary combobox trick, without which a click would blur us shut.
                      event.preventDefault();
                    }}
                    onClick={() => {
                      if (completing) completeCommand(command);
                    }}
                  >
                    <span className="composer__slash-name">/{command.name}</span>
                    <span className="composer__slash-desc">{command.description}</span>
                    <span className="composer__slash-usage">{command.usage}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <textarea
            ref={textarea}
            className="composer__input"
            value={text}
            rows={1}
            spellCheck={true}
            disabled={disabled || busy}
            placeholder={placeholder}
            data-shape={rounded ? 'round' : 'neutral'}
            data-settling={settling || undefined}
            onFocus={() => setRounded(true)}
            // Focus alone would leave the box flat after a send, since sending never took
            // the cursor away — clicking back into it has to count as picking it up again.
            onPointerDown={() => setRounded(true)}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
              setSlashDismissed(false);
              setSlashIndex(0);
              setRounded(true);
            }}
            onBlur={() => {
              setSlashDismissed(true);
              setRounded(false);
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={slashOpen}
            aria-controls={slashOpen ? listboxId : undefined}
            aria-activedescendant={
              activeIndex >= 0 && suggestions[activeIndex]
                ? `${listboxId}-${suggestions[activeIndex].name}`
                : undefined
            }
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is a newline. While the command name is still
              // being typed, Enter completes it instead — running `/h` because you were
              // about to pick `/hide` is how a keystroke becomes the wrong command.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (completing && suggestions[activeIndex]) {
                  completeCommand(suggestions[activeIndex]);
                } else {
                  void submit();
                }
                return;
              }
              if (completing) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSlashIndex((index) => (index + 1) % suggestions.length);
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSlashIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
                  return;
                }
                if (event.key === 'Tab' && suggestions[activeIndex]) {
                  event.preventDefault();
                  completeCommand(suggestions[activeIndex]);
                  return;
                }
              }
              if (slashOpen && event.key === 'Escape') {
                event.preventDefault();
                setSlashDismissed(true);
              }
            }}
          />
        </div>

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
            onClick={() => void submit()}
            disabled={disabled || !text.trim()}
            title="Send (Enter)"
          >
            <SendIcon />
            Send
          </button>
        )}
      </div>
    </div>
  );
}
