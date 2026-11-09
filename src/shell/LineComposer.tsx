/**
 * The Line: the 3.0 composer. No box. You write on one line of light in your persona's
 * colour, which brightens while you write and breathes while a reply comes in.
 *
 * The draft stays private here: the chat only ever
 * sees text handed to `onSend`, `onGuide` or `onGuidedSwipe`, and `insert`/`replace` are
 * the only ways in. Slash commands and `{{macros}}` complete inline; what you type is
 * coloured the way the chat will show it (live ink). Every action is one click or typed.
 */

import type { PersistentGuide } from '@shared/types/chat.ts';
import type { GuidanceSettings, QuickCommand } from '@shared/types/settings.ts';
import {
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  MacroCompletionList,
  macroComboboxProps,
  useMacroCompletion,
} from '../components/MacroCompletion.tsx';
import { GuidesPopover } from '../features/chat/GuidesPopover.tsx';
import { type SlashCommandHelp, slashCompletion } from '../features/chat/slashCommands.ts';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import { Icon, type IconName } from './icons.tsx';
import { inkSegments } from './ink.ts';
import { LineCommands } from './LineCommands.tsx';
import { caretLeft, LineLight, type LineLightHandle } from './LineLight.tsx';

export interface LineHandle {
  /** Append on a new line when there is a draft, replace when there is not. */
  insert: (text: string) => void;
  /** Replace the whole draft: the impersonation write. */
  replace: (text: string) => void;
  focus: () => void;
}

interface LineComposerProps {
  onSend: (text: string) => Promise<string | null>;
  onGuide: (text: string) => void;
  onGuidedSwipe: (text: string) => void;
  guidedSwipeDisabledReason?: string;
  onImpersonate: (text: string) => void;
  impersonating: boolean;
  stream: StreamStore;
  onContinue: () => void;
  continueDisabledReason?: string;
  onStop: () => void;
  /** Something is generating: actions wait, Send turns into Stop. */
  busy: boolean;
  /** Writing is impossible, e.g. no chat model: the line goes dashed. */
  disabled: boolean;
  disabledReason?: string;
  onChooseModel?: () => void;
  placeholder: string;
  guides: PersistentGuide[];
  onGuidesChange: (next: PersistentGuide[]) => void;
  guidance: GuidanceSettings;
  onGuidanceChange: (patch: Partial<GuidanceSettings>) => void;
  quickCommands: QuickCommand[];
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
  onDraftChange?: (text: string) => void;
  /** Called with the field's position just before a send, for the lift-off. */
  onBeforeSend?: (from: DOMRect) => void;
  /** The chat's current error; a new one makes the line flicker. */
  failed?: string | null;
  ref?: Ref<LineHandle>;
}

const IDLE = { text: '', reasoning: '', active: false, incremental: false };
const MAX_HEIGHT = 0.4;

export function LineComposer({
  onSend,
  onGuide,
  onGuidedSwipe,
  guidedSwipeDisabledReason,
  onImpersonate,
  impersonating,
  stream,
  onContinue,
  continueDisabledReason,
  onStop,
  busy,
  disabled,
  disabledReason,
  onChooseModel,
  placeholder,
  guides,
  onGuidesChange,
  guidance,
  onGuidanceChange,
  quickCommands,
  onQuickCommandsChange,
  onDraftChange,
  onBeforeSend,
  failed = null,
  ref,
}: LineComposerProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inkRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const lightRef = useRef<LineLightHandle>(null);
  const listboxId = useId();
  // The input that started a generation, so focus comes back to it after.
  const focusBeforeGenerate = useRef<Element | null>(null);

  // While the model writes your line for you, the field shows it arriving.
  const streamLive = impersonating;
  const subscribe = useCallback(
    (listener: () => void) => (streamLive ? stream.subscribe(listener) : () => {}),
    [streamLive, stream],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    streamLive ? stream.getSnapshot() : IDLE,
  );
  const displayed = streamLive && snapshot.active ? snapshot.text : text;

  useEffect(() => {
    onDraftChange?.(text);
  }, [text, onDraftChange]);

  // When the reply is in, the Line takes focus back, unless you have moved on to
  // something else in the meantime (editing a message, a tool, a popover).
  useEffect(() => {
    if (busy || !focusBeforeGenerate.current) return;
    const active = document.activeElement;
    if (active === document.body || active === null || formRef.current?.contains(active)) {
      textarea.current?.focus({ preventScroll: true });
    }
    focusBeforeGenerate.current = null;
  }, [busy]);

  // --- Completion: {{macros}} outrank slash commands ---------------------------------

  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
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

  function completeCommand(command: SlashCommandHelp) {
    setText(`/${command.name} `);
    setError(null);
    setSlashDismissed(false);
    setSlashIndex(0);
    textarea.current?.focus({ preventScroll: true });
  }

  useImperativeHandle(
    ref,
    () => ({
      insert(added: string) {
        setText((current) => {
          const trimmed = current.trimEnd();
          return trimmed ? `${trimmed}\n${added}` : added;
        });
        setSlashDismissed(false);
        macro.dismiss();
        setTimeout(() => textarea.current?.focus({ preventScroll: true }), 0);
      },
      replace(next: string) {
        setText(next);
        setSlashDismissed(false);
        macro.dismiss();
        setTimeout(() => textarea.current?.focus({ preventScroll: true }), 0);
      },
      focus() {
        textarea.current?.focus({ preventScroll: true });
      },
    }),
    [macro.dismiss],
  );

  // Grow with the text, then scroll inside; the ink mirror follows the same scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the trigger, read through the element
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const resize = () => {
      element.style.height = 'auto';
      const max = Math.round(window.innerHeight * MAX_HEIGHT);
      element.style.height = `${Math.min(element.scrollHeight, max)}px`;
      if (inkRef.current) inkRef.current.scrollTop = element.scrollTop;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [displayed]);

  // The bright spot on the line sits under the caret while you write.
  const placeSpark = useCallback(() => {
    const field = textarea.current;
    const ink = inkRef.current;
    const row = rowRef.current;
    const light = lightRef.current;
    if (!field || !ink || !row || !light) return;
    if (document.activeElement !== field) {
      light.spark(null);
      return;
    }
    const rowLeft = row.getBoundingClientRect().left;
    const left =
      caretLeft(ink, field.selectionStart ?? 0) ??
      fieldRef.current?.getBoundingClientRect().left ??
      rowLeft;
    light.spark(left - rowLeft);
  }, []);

  // The ink has re-rendered with the new text by now, so the caret can be measured.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the trigger
  useLayoutEffect(() => {
    placeSpark();
  }, [displayed, placeSpark]);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    focusBeforeGenerate.current = document.activeElement;
    const rect = fieldRef.current?.getBoundingClientRect();
    const isCommand = trimmed.startsWith('/');
    if (rect && !isCommand) onBeforeSend?.(rect);
    if (!isCommand) lightRef.current?.launch();
    const failure = await onSend(trimmed);
    if (failure) {
      setError(failure);
      lightRef.current?.alarm();
      focusBeforeGenerate.current = null;
      return;
    }
    setError(null);
    setText((current) => (current.trim() === trimmed ? '' : current));
  }

  function guided(action: (text: string) => void) {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    focusBeforeGenerate.current = document.activeElement;
    action(trimmed);
  }

  function pinGuide() {
    const trimmed = text.trim();
    if (!trimmed) return;
    // The chip shows the name; a short note is its own name, a long one is trimmed.
    const name = trimmed.length > 48 ? `${trimmed.slice(0, 47).trimEnd()}…` : trimmed;
    onGuidesChange([...guides, { id: crypto.randomUUID(), name, text: trimmed, enabled: true }]);
    setText('');
  }

  const has = Boolean(text.trim());
  const waiting = 'Wait for the current reply to finish.';
  const blocked = disabled ? (disabledReason ?? 'Writing is unavailable right now.') : null;
  const needsText = (action: string) =>
    has ? undefined : `Type what should happen, then ${action}.`;

  const enabledGuides = guides.filter((guide) => guide.enabled);

  return (
    <form
      ref={formRef}
      className="w3-line"
      data-active={focused || has || undefined}
      data-busy={busy || undefined}
      data-blocked={blocked ? true : undefined}
      data-voice={busy && !impersonating ? 'char' : 'me'}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) onStop();
        else void submit();
      }}
    >
      {/* Shown while the chat has any guide, so switched-off ones stay reachable. */}
      {guides.length ? (
        <div className="w3-guides">
          <GuidesPopover
            guides={guides}
            onGuidesChange={onGuidesChange}
            guidance={guidance}
            onGuidanceChange={onGuidanceChange}
            renderTrigger={(trigger, toggle) => (
              <button
                {...trigger}
                type="button"
                className="w3-guides__label"
                title="Manage guides"
                onClick={toggle}
              >
                Guides
              </button>
            )}
          />
          {enabledGuides.map((guide) => (
            <span key={guide.id} className="w3-guide" title={guide.text}>
              <Icon name="pin" size="xs" />
              <span>{guide.name || guide.text}</span>
              <button
                type="button"
                className="w3-guide__x"
                aria-label={`Remove guide: ${guide.name || guide.text}`}
                onClick={() => onGuidesChange(guides.filter((g) => g.id !== guide.id))}
              >
                <Icon name="close" size="xs" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="w3-line__error" role="alert">
          <Icon name="alert" size="sm" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="w3-line__row" ref={rowRef}>
        <LineLight ref={lightRef} busy={busy} stream={stream} failed={failed} />
        <span className="w3-line__acts">
          <LineCommands
            commands={quickCommands}
            onChange={onQuickCommandsChange}
            onInsert={(added) => {
              setText((current) => {
                const trimmed = current.trimEnd();
                return trimmed ? `${trimmed}\n${added}` : added;
              });
              setSlashDismissed(false);
              setTimeout(() => textarea.current?.focus({ preventScroll: true }), 0);
            }}
          />
          <LineAction
            icon="mask"
            label="Impersonate"
            onClick={() => onImpersonate(text)}
            reason={blocked ?? (busy ? waiting : undefined)}
          />
          <LineAction
            icon="forward"
            label="Continue"
            onClick={onContinue}
            reason={blocked ?? (busy ? waiting : continueDisabledReason)}
          />
        </span>

        <div className="w3-line__field" ref={fieldRef}>
          <MacroCompletionList handle={macro} />
          {slashOpen ? (
            <div className="w3-slash" role="listbox" aria-label="Slash commands">
              {suggestions.map((command, index) => {
                const active = index === activeIndex;
                return (
                  <button
                    type="button"
                    key={command.name}
                    id={`${listboxId}-${command.name}`}
                    role="option"
                    aria-selected={active}
                    className="w3-slash__item"
                    data-active={active || undefined}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (completing) completeCommand(command);
                    }}
                  >
                    <span className="w3-slash__name">/{command.name}</span>
                    <span className="w3-slash__desc">{command.description}</span>
                    <span className="w3-slash__usage">{command.usage}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="w3-ink" ref={inkRef} aria-hidden="true">
            {inkSegments(displayed).map((segment, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional by nature
              <span key={index} data-ink={segment.kind}>
                {segment.text}
              </span>
            ))}
            {/* A trailing newline needs something after it to take up its line. */}
            {'​'}
          </div>
          <textarea
            ref={textarea}
            className="w3-line__input"
            value={displayed}
            rows={1}
            spellCheck
            disabled={disabled}
            // Read-only, not disabled, while a reply runs: a disabled field drops focus,
            // and the Line should still hold it when the reply is in.
            readOnly={busy}
            placeholder={placeholder}
            aria-label="Your message"
            onFocus={() => {
              setFocused(true);
              requestAnimationFrame(placeSpark);
            }}
            onClick={placeSpark}
            onKeyUp={placeSpark}
            onBlur={() => {
              setFocused(false);
              lightRef.current?.spark(null);
              setSlashDismissed(true);
              macro.dismiss();
            }}
            onScroll={(event) => {
              if (inkRef.current) inkRef.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onChange={(event) => {
              setText(event.target.value);
              lightRef.current?.kick();
              setError(null);
              setSlashDismissed(false);
              setSlashIndex(0);
              macro.sync();
            }}
            onSelect={() => {
              macro.sync();
              placeSpark();
            }}
            {...(macro.open
              ? macroComboboxProps(macro)
              : {
                  role: 'combobox' as const,
                  'aria-autocomplete': 'list' as const,
                  'aria-expanded': slashOpen,
                  'aria-activedescendant':
                    activeIndex >= 0 && suggestions[activeIndex]
                      ? `${listboxId}-${suggestions[activeIndex].name}`
                      : undefined,
                })}
            onKeyDown={(event) => {
              if (macro.handleKeyDown(event)) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (completing && suggestions[activeIndex])
                  completeCommand(suggestions[activeIndex]);
                else void submit();
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

        <span className="w3-line__acts">
          <LineAction
            icon="compass"
            label="Guide the next reply"
            onClick={() => guided(onGuide)}
            reason={blocked ?? (busy ? waiting : needsText('Guide'))}
          />
          <LineAction
            icon="guidedSwipe"
            label="Guided swipe"
            onClick={() => guided(onGuidedSwipe)}
            reason={
              blocked ?? (busy ? waiting : (guidedSwipeDisabledReason ?? needsText('Guided swipe')))
            }
          />
          <LineAction
            icon="pin"
            label="Pin as a guide"
            onClick={pinGuide}
            reason={has ? undefined : 'Type a note, then pin it to steer every reply.'}
          />
        </span>

        <button
          type="submit"
          className="w3-send"
          data-stop={busy || undefined}
          disabled={!busy && Boolean(blocked)}
          aria-label={busy ? 'Stop' : 'Send'}
          title={busy ? 'Stop' : (blocked ?? 'Send (Enter)')}
        >
          <span className="w3-send__face" data-face="send">
            <Icon name="send" />
          </span>
          <span className="w3-send__face" data-face="stop">
            <Icon name="stop" />
          </span>
        </button>
      </div>

      {blocked && onChooseModel ? (
        <button type="button" className="w3-textbtn w3-line__cta" onClick={onChooseModel}>
          Choose a model
        </button>
      ) : null}
    </form>
  );
}

function LineAction({
  icon,
  label,
  onClick,
  reason,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  reason?: string | null;
}) {
  return (
    <button
      type="button"
      className="w3-line__act"
      aria-label={label}
      data-tip={reason ?? label}
      disabled={Boolean(reason)}
      onClick={onClick}
    >
      <Icon name={icon} size="sm" />
    </button>
  );
}
