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
import {
  MacroCompletionList,
  macroComboboxProps,
  useMacroCompletion,
} from '../../components/MacroCompletion.tsx';
import { GuidedSwipeIcon, SendIcon, StopIcon, WandIcon } from '../../layout/icons.tsx';
import { composerMaxHeight, rowCap } from './composerGrowth.ts';
import { type SlashCommandHelp, slashCompletion } from './slashCommands.ts';
import './Composer.css';

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
   * Who you are writing as, at the head of the tray. A slot for the same reason `leading`
   * is one: the composer owns a draft, and knows nothing about personas.
   */
  identity?: ReactNode;
  /**
   * Rendered at the start of the tray. A slot rather than a concrete menu so the composer
   * stays ignorant of the chat hook.
   */
  leading?: ReactNode;
  /**
   * Rendered at the head of the tray's right-hand cluster, before the draft actions.
   *
   * That side is "what happens to this draft", which is why the persistent-guides popover
   * belongs here rather than beside the menus: it and the wand are the same idea, one
   * standing and one for this turn, and they used to sit on opposite sides of the field.
   */
  trailing?: ReactNode;
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
  identity,
  leading,
  trailing,
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
  /**
   * The send moment, armed the instant a send is accepted and revoked when one fails. Two
   * animations read it off the root's `data-settling`: the input's settle wobble and the
   * field's one-shot light sweep. Retired on a timer rather than on `animationend` — see
   * the effect below.
   */
  const [settling, setSettling] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
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
   * `none`, so it never fires and the flag sticks forever. A timer past the longer of the
   * two animations (the sweep, at 560ms) is right in both worlds.
   */
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), 640);
    return () => clearTimeout(timer);
  }, [settling]);

  // --- Slash command autocomplete -------------------------------------------

  // The highlighted option and a "closed until the text changes" flag. Visibility is
  // otherwise derived from the draft, so typing `/` is what summons the box.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  /*
   * The `{{` box, declared ahead of the slash box because it outranks it.
   *
   * Both can be live at once — `/rename {{ch` is a command with a macro in its argument —
   * and two popovers stacked over the transcript is worse than either. The macro box wins
   * because it is the one still asking a question: by the time a macro is being typed the
   * command name is long settled, so the slash box is only restating what you already wrote.
   */
  const macro = useMacroCompletion({
    value: text,
    onChange: setText,
    textareaRef: textarea,
    enabled: !disabled && !busy,
  });

  const completion = slashCompletion(text);
  const suggestions = completion?.suggestions ?? [];
  const slashOpen = Boolean(
    completion && suggestions.length > 0 && !slashDismissed && !disabled && !busy && !macro.open,
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
        // The caret the macro box last saw points into the text this just replaced. Closing
        // it costs nothing: the next keystroke syncs the caret and opens it again.
        macro.dismiss();
        // A menu selection restores focus to the menu's trigger AFTER `onSelect` runs, so
        // the focus waits one tick to win — "ready to send" means the cursor is here.
        setTimeout(() => textarea.current?.focus({ preventScroll: true }), 0);
      },
    }),
    [macro.dismiss],
  );

  /**
   * Grow with the content, up to a cap, then scroll internally.
   *
   * Re-measured on a width change as well as on typing. That is not a nicety: a
   * measurement taken while the composer is narrow reads a `scrollHeight` far too large
   * and clamps to MAX_ROWS, and with `text` as the only trigger that wrong height then
   * sticks for the life of the component.
   */
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;

    /**
     * Everything in the composer that is not the input: the tray, plus the gap above it.
     *
     * Measured rather than named as a constant, because it is a sum of tokens — one
     * `--wc-control` row and the column's own gap — and a hardcoded number would drift
     * silently the first time either moved. This is the value the viewport ceiling is
     * charged for; see `composerMaxHeight`.
     */
    const measureTrayBlock = (): number => {
      const tray = trayRef.current;
      const root = rootRef.current;
      if (!tray || !root) return 0;
      const trayHeight = tray.offsetHeight;
      if (!trayHeight) return 0;
      return trayHeight + (Number.parseFloat(getComputedStyle(root).rowGap) || 0);
    };

    const resize = () => {
      // Empty means exactly one row, and that needs no measuring — dropping the inline
      // height falls back to the `rows={1}` height the stylesheet gives it.
      //
      // This is the case worth special-casing rather than trusting the measurement for:
      // measured while the composer is narrow (mid-transition, or laid out inside a
      // collapsed column) the PLACEHOLDER wraps to a character per line, `scrollHeight`
      // comes back enormous, and the clamp below pins an empty composer at max rows
      // for the life of the component.
      if (!text) {
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

      // One row, as the stylesheet defines it: `min-height` on the input IS
      // `--wc-composer-row`, so the floor comes from the same token everything else in the
      // composer is sized against rather than from a number retyped here.
      const oneRow =
        Number.parseFloat(style.minHeight) || lineHeight + verticalPadding + verticalBorders || 0;

      // The visual viewport, where there is one: with a phone keyboard up it is the part
      // of the window still visible, which is the height the composer actually has to fit.
      const viewportHeight = globalThis.visualViewport?.height ?? globalThis.innerHeight;
      const maxHeight = composerMaxHeight({
        rowCap: rowCap({ lineHeight, verticalPadding, verticalBorders }),
        viewportHeight,
        trayBlock: measureTrayBlock(),
        rowHeight: oneRow,
      });

      const prevScrollTop = element.scrollTop;
      element.style.height = 'auto';

      const targetHeight = Math.min(element.scrollHeight + verticalBorders, maxHeight);
      element.style.height = `${targetHeight}px`;

      // Restore scroll position or follow the caret
      if (document.activeElement === element) {
        const isNearEnd = element.selectionEnd === null || element.selectionEnd >= text.length - 1;
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
    // is what changes the height. Width is what actually invalidates the measurement: a
    // panel opening or closing, and the 0 -> real first layout.
    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return;
      lastWidth = element.clientWidth;
      resize();
    });
    observer.observe(element);

    /*
     * The tray's HEIGHT, which the input's ceiling is charged for.
     *
     * Safe to observe where the input's own height is not: the tray is sized by its
     * controls, never by the textarea, so this cannot feed back the way observing the
     * input's height would. It fires when the tray wraps to two lines in a narrow column,
     * or when a control is added to it.
     */
    let lastTrayHeight = trayRef.current?.offsetHeight ?? 0;
    const trayObserver = new ResizeObserver(() => {
      const height = trayRef.current?.offsetHeight ?? 0;
      if (height === lastTrayHeight) return;
      lastTrayHeight = height;
      resize();
    });
    if (trayRef.current) trayObserver.observe(trayRef.current);

    // The viewport ceiling moves with the window, and a height-only resize changes neither
    // the textarea's width nor its content — so nothing above would re-measure for it.
    globalThis.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      trayObserver.disconnect();
      globalThis.removeEventListener('resize', resize);
    };
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
    // The send moment arms on the click, not on the resolution. For a normal message
    // `onSend` dispatches the generation synchronously before it returns, so this lands in
    // the SAME render as `busy` — the wobble, the sweep and the button's turn into Stop all
    // start on the very frame the generation begins. A failure revokes it: one that comes
    // back synchronously (a mis-parsed command) is revoked before the armed frame is ever
    // painted, and one that comes back late has already played — the cost of arming
    // optimistically, and cheaper than gating the animation on a network round-trip.
    setSettling(true);
    const failure = await onSend(trimmed);
    if (failure) {
      setError(failure);
      setSettling(false);
      // No generation ran, so nothing disabled the input — the snapshot must not leak
      // into a later busy cycle it had nothing to do with.
      focusBeforeGenerate.current = null;
      return;
    }
    setError(null);
    // Sent: let the shape relax. A failure returns above without this, since the draft is
    // still yours to work on and the box should still look like it — the settling pin in
    // Composer.css holds the box neutral while the moment plays, and lifting the flag lets
    // the shape state decide again.
    setRounded(false);
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

  // Send and Stop share one persistent button; this is which face it wears. Driven by
  // `busy` alone, so the turn happens on the very frame the generation starts — the same
  // render the sweep and the wobble land in (see submit). The cost, accepted: a second
  // click inside the turn acts as a Stop for the generation the first one just started.
  // Recoverable with the transcript's retry, and better than the button lying about being
  // Send for the first moments of a generation.
  const showStop = busy;

  return (
    <div
      className="composer"
      ref={rootRef}
      data-busy={busy || undefined}
      data-settling={settling || undefined}
    >
      {error ? (
        <div className="composer__error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="composer__field">
        <MacroCompletionList handle={macro} />

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
                  className={`composer__slash-item${active ? ' composer__slash-item--active' : ''}`}
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
            macro.sync();
          }}
          // Caret moves as well as edits: `{{ro` is only a question while the caret is
          // still inside those braces, and clicking away from them has to close the box.
          onSelect={macro.sync}
          onBlur={() => {
            setSlashDismissed(true);
            macro.dismiss();
            setRounded(false);
          }}
          // One control, two possible listboxes — so it describes whichever is open, and
          // never both. `macro.open` already suppresses `slashOpen`, so the branch is safe.
          {...(macro.open
            ? macroComboboxProps(macro)
            : {
                role: 'combobox' as const,
                'aria-autocomplete': 'list' as const,
                'aria-expanded': slashOpen,
                'aria-controls': slashOpen ? listboxId : undefined,
                'aria-activedescendant':
                  activeIndex >= 0 && suggestions[activeIndex]
                    ? `${listboxId}-${suggestions[activeIndex].name}`
                    : undefined,
              })}
          onKeyDown={(event) => {
            // First refusal, before Enter can mean send: an open macro box owns Enter,
            // Tab, the arrows and Escape.
            if (macro.handleKeyDown(event)) return;

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

      {/*
       * The tray.
       *
       * Below the field rather than either side of it, which is what gives the input the
       * column's full width. It is also the composer's FIXED end: the dock is
       * `flex-shrink: 0` at the bottom of the chat column, so the composer grows upward and
       * whatever sits at its bottom holds a constant screen position however tall the draft
       * gets. Nothing here moves while you type.
       *
       * Left is who you are and what you can open; right is what happens to this draft.
       */}
      <div className="composer__tray" ref={trayRef}>
        {identity}
        {identity && leading ? <span className="composer__tray-rule" aria-hidden="true" /> : null}
        {leading}

        <span className="composer__tray-spacer" />

        {trailing}

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

        {/* One persistent button, two faces: Send turns into Stop with a crossfade in
            place, the surface morphing with it — no slot ever going empty, no remount. The
            turn fires on the send frame itself (see `showStop`). */}
        <button
          type="button"
          className={`wc-button composer__button ${
            showStop ? 'wc-button--danger' : 'wc-button--primary'
          }`}
          onClick={showStop ? onStop : () => void submit()}
          disabled={disabled || (!showStop && !text.trim())}
          title={showStop ? 'Stop generating' : 'Send (Enter)'}
        >
          <span className="composer__button-face" data-hidden={showStop || undefined}>
            <SendIcon />
            Send
          </span>
          <span className="composer__button-face" data-hidden={!showStop || undefined}>
            <StopIcon />
            Stop
          </span>
        </button>
      </div>
    </div>
  );
}
