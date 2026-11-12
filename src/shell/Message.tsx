/**
 * One turn of the conversation, in the 3.0 transcript.
 *
 * Memoised, which only works because the chat surface hoists its callbacks: every prop is
 * a primitive or a stable reference, so a token streaming into the last row repaints that
 * row alone.
 */

import { currentText, type MessageState, swipeCount } from '@shared/chat/message.ts';
import { isProviderId, PROVIDERS } from '@shared/providers/types.ts';
import {
  type CSSProperties,
  memo,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Menu, type MenuEntry } from '../components/Menu.tsx';
import type { CardReaderInit } from '../features/chat/CardReader.tsx';
import { CreatorNotesPopover } from '../features/chat/CreatorNotesPopover.tsx';
import { formatTimestamp } from '../features/chat/formatDate.ts';
import { Markdown } from '../features/chat/Markdown.tsx';
import { StreamingText } from '../features/chat/StreamingText.tsx';
import type { CardStore } from '../features/chat/state/cardStore.ts';
import type { GenMode } from '../features/chat/state/chatReducer.ts';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import { resolveSwipeMotion, type SwipeMotionDir } from '../features/chat/swipeMotion.ts';
import { Avatar } from './Avatar.tsx';
import { CardGlance } from './CardViews.tsx';
import { Icon } from './icons.tsx';

interface MessageProps {
  message: MessageState;
  avatarUrl: string | null;
  /** Whether quoted speech is coloured at all (the dialogue-colour setting). */
  dialogueActive: boolean;
  /** The speaker's own dialogue colour, when known. */
  dialogueColor: string | null;
  dialogueGradient?: string | null;
  streaming: boolean;
  /** The character's card, opened from the portrait. None on your own messages. */
  card?: MessageCard;
  /** Show the reply whole once it is finished, not word by word (Reveal replies). */
  revealWhole?: boolean;
  flash: boolean;
  mode: GenMode | null;
  stream: StreamStore;
  isLast: boolean;
  busy: boolean;
  summaryRunning: boolean;
  displayText?: string;
  displayReasoning?: string;
  creatorNotes?: string;
  greetingCount?: number;
  onSwipe: (direction: -1 | 1) => void;
  onSwipeTo: (id: string, index: number) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  onRetry: () => void;
  onEdit: (id: string, text: string) => void;
  onEditReasoning: (id: string, reasoning: string) => void;
  onDelete: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onBranch: (id: string) => void;
  onCopied: (ok: boolean) => void;
}

/** What a character's portrait needs to open their card. */
export interface MessageCard {
  store: CardStore;
  line: string;
  onOpenReader: (init: CardReaderInit) => void;
  onEditCharacter: () => void;
}

export const Message = memo(function Message({
  message,
  avatarUrl,
  dialogueActive,
  dialogueColor,
  dialogueGradient,
  streaming,
  revealWhole,
  card,
  flash,
  mode,
  stream,
  isLast,
  busy,
  summaryRunning,
  displayText,
  displayReasoning,
  creatorNotes,
  greetingCount,
  onSwipe,
  onSwipeTo,
  onRegenerate,
  onContinue,
  onRetry,
  onEdit,
  onEditReasoning,
  onDelete,
  onToggleHidden,
  onBranch,
  onCopied,
}: MessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const openScrollTopRef = useRef<number | null>(null);

  // The swipe entrance: replayed by remounting the body on a bump, set only when a change
  // really is a swipe or a re-roll, so loading a chat stays still.
  const [motion, setMotion] = useState<{ n: number; dir: SwipeMotionDir } | null>(null);
  const prevSwipeRef = useRef(message.swipe_id);
  const prevStreamingRef = useRef(false);
  // A reply revealed whole fades in once, the moment it is finished.
  const [reveal, setReveal] = useState(0);
  useLayoutEffect(() => {
    if (prevStreamingRef.current && !streaming && revealWhole) setReveal((n) => n + 1);
  }, [streaming, revealWhole]);
  useLayoutEffect(() => {
    const dir = resolveSwipeMotion({
      swipeId: message.swipe_id,
      streaming,
      mode,
      prevSwipeId: prevSwipeRef.current,
      prevStreaming: prevStreamingRef.current,
    });
    prevSwipeRef.current = message.swipe_id;
    prevStreamingRef.current = streaming;
    if (dir) setMotion((m) => ({ n: (m?.n ?? 0) + 1, dir }));
  }, [message.swipe_id, streaming, mode]);

  const text = currentText(message);
  const renderedText = displayText ?? text;
  const swipes = swipeCount(message);
  const info = message.swipe_info[message.swipe_id];
  const reasoning = typeof info?.extra?.reasoning === 'string' ? info.extra.reasoning : '';
  const isUser = message.is_user;
  const canReply = isLast && !isUser;
  const canRetry = isLast && isUser;
  const timestamp = formatTimestamp(info?.send_date);
  const providerId = info?.extra?.api;
  const providerLabel =
    typeof providerId === 'string' && isProviderId(providerId) ? PROVIDERS[providerId].label : null;
  const model = info?.extra?.model ? String(info.extra.model) : null;

  useAutoGrowTextarea(editorRef, editing, draft, openScrollTopRef);

  function startEditing() {
    const scroller = articleRef.current?.closest<HTMLElement>('.w3-transcript');
    openScrollTopRef.current = scroller ? scroller.scrollTop : null;
    setDraft(text);
    setMotion(null);
    setEditing(true);
  }

  function commitEdit() {
    if (draft !== text) onEdit(message.id, draft);
    setEditing(false);
  }

  const copy = () => {
    try {
      navigator.clipboard.writeText(renderedText).then(
        () => onCopied(true),
        () => onCopied(false),
      );
    } catch {
      onCopied(false);
    }
  };

  const moreEntries: MenuEntry[] = [
    {
      label: 'Branch from here',
      icon: <Icon name="branch" size="sm" />,
      description: 'A new chat that ends at this message',
      disabled: busy,
      disabledReason: 'Wait for the current reply to finish.',
      onSelect: () => onBranch(message.id),
    },
    {
      label: message.is_system ? 'Show to the model' : 'Hide from the prompt',
      icon: <Icon name={message.is_system ? 'eye' : 'eyeOff'} size="sm" />,
      description: message.is_system
        ? 'It goes back into the prompt'
        : 'Stays in the chat, left out of the prompt',
      onSelect: () => onToggleHidden(message.id),
    },
  ];

  const style = {
    '--w3-say': dialogueColor ?? 'var(--w3-dialogue)',
    '--dialogue-gradient': dialogueGradient ?? 'none',
  } as CSSProperties;

  return (
    <article
      ref={articleRef}
      className="w3-msg"
      data-message-id={message.id}
      data-role={isUser ? 'user' : 'assistant'}
      data-hidden={message.is_system || undefined}
      data-flash={flash || undefined}
      data-last={isLast || undefined}
      data-editing={editing || undefined}
      data-dialogue={dialogueActive || undefined}
      data-dialogue-gradient={!!dialogueGradient || undefined}
      style={style}
    >
      {card && !isUser ? (
        <CardGlance
          store={card.store}
          name={message.name}
          avatarUrl={avatarUrl}
          line={card.line}
          busy={busy}
          onOpenReader={card.onOpenReader}
          onEditCharacter={card.onEditCharacter}
        />
      ) : (
        <Avatar url={avatarUrl} name={message.name} size="md" who={isUser ? 'me' : 'char'} />
      )}
      <div className="w3-msg__body">
        <div className="w3-msg__bubble">
          <header className="w3-msg__head">
            <span className="w3-msg__name">{message.name}</span>
            <span className="w3-msg__meta">
              {timestamp ? (
                <time className="w3-msg__time" dateTime={timestamp.iso} title={timestamp.full}>
                  {timestamp.short}
                </time>
              ) : null}
              {model ? (
                <span
                  className="w3-msg__prov"
                  title={providerLabel ? `${providerLabel} · ${model}` : model}
                >
                  {model}
                </span>
              ) : null}
              {message.is_system ? (
                <span
                  className="w3-msg__flag"
                  title={
                    message.hiddenBy === 'summary'
                      ? 'Hidden because the summary covers it. Reveal it to send it again.'
                      : message.hiddenBy
                        ? 'Hidden by a memory. Deleting or revealing that memory brings it back.'
                        : 'Hidden from the prompt by hand, shown here'
                  }
                >
                  <Icon name="eyeOff" size="xs" />
                  Hidden from the prompt
                </span>
              ) : null}
              {info?.extra?.truncated ? (
                <span className="w3-msg__flag" data-tone="warn" title="Generation stopped early">
                  Stopped early
                </span>
              ) : null}
            </span>
          </header>

          {!streaming && reasoning ? (
            <ReasoningBlock
              text={reasoning}
              displayText={displayReasoning}
              onEdit={(next) => onEditReasoning(message.id, next)}
            />
          ) : null}

          {editing ? (
            <div className="w3-msg__editor">
              <textarea
                ref={editorRef}
                className="w3-msg__edit"
                value={draft}
                rows={1}
                aria-label="Edit message"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setEditing(false);
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    commitEdit();
                  }
                }}
              />
              <div className="w3-msg__edit-bar">
                <span className="w3-msg__edit-hint">⌘↵ saves · Esc cancels</span>
                <div className="w3-msg__edit-acts">
                  <button
                    type="button"
                    className="w3-st-ghost w3-st-ghost--sm"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                  <button type="button" className="w3-msg__save" onClick={commitEdit}>
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              key={`${motion?.n ?? 0}:${reveal}`}
              className={
                motion
                  ? `w3-msg__content w3-motion w3-motion--${motion.dir}`
                  : reveal
                    ? 'w3-msg__content w3-reveal'
                    : 'w3-msg__content'
              }
            >
              {streaming && revealWhole ? (
                <WritingWhole stream={stream} />
              ) : streaming ? (
                <>
                  <LiveReasoning stream={stream} />
                  <StreamingText store={stream} hideReasoning />
                </>
              ) : (
                <Markdown text={renderedText} />
              )}
            </div>
          )}
        </div>

        {!editing && !streaming ? (
          <footer className="w3-msg__tools">
            {canRetry ? (
              <button
                type="button"
                className="w3-retry"
                onClick={onRetry}
                disabled={busy || summaryRunning}
                title="Generate a reply to this message"
              >
                <Icon name="refresh" size="sm" />
                Get a reply
              </button>
            ) : null}
            {canReply ? (
              <span className="w3-swipe">
                {creatorNotes?.trim() ? (
                  <CreatorNotesPopover
                    notes={creatorNotes}
                    greetingCount={greetingCount ?? swipes}
                    swipeIndex={message.swipe_id}
                    onSelectScenario={(index) => onSwipeTo(message.id, index)}
                    swipeCount={swipes}
                    busy={busy}
                  />
                ) : null}
                <button
                  type="button"
                  className="w3-tbtn"
                  onClick={() => onSwipe(-1)}
                  disabled={busy || message.swipe_id === 0}
                  data-invisible={message.swipe_id === 0 || undefined}
                  aria-label="Previous alternative"
                  title="Previous alternative"
                >
                  <Icon name="chevronLeft" size="sm" />
                </button>
                <span className="w3-swipe__n">
                  {message.swipe_id + 1}/{swipes}
                </span>
                <button
                  type="button"
                  className="w3-tbtn"
                  onClick={() => onSwipe(1)}
                  disabled={busy || (summaryRunning && message.swipe_id === swipes - 1)}
                  aria-label="Next alternative, or generate one"
                  title={
                    message.swipe_id === swipes - 1
                      ? 'Generate another alternative'
                      : 'Next alternative'
                  }
                >
                  <Icon name="chevronRight" size="sm" />
                </button>
              </span>
            ) : null}
            {canReply ? (
              <>
                <ToolButton
                  icon="refresh"
                  label="Regenerate"
                  onClick={onRegenerate}
                  disabled={busy || summaryRunning}
                />
                <ToolButton
                  icon="forward"
                  label="Continue"
                  onClick={onContinue}
                  disabled={busy || summaryRunning}
                />
              </>
            ) : null}
            <ToolButton icon="pencil" label="Edit" onClick={startEditing} />
            <ToolButton icon="copy" label="Copy" onClick={copy} />
            {/* Delete is one click away, and a second click in place confirms it. */}
            <button
              type="button"
              className="w3-tbtn w3-tbtn--delete"
              data-armed={confirmDelete || undefined}
              disabled={busy && isLast}
              aria-label={confirmDelete ? 'Click again to delete' : 'Delete'}
              title={
                busy && isLast
                  ? 'Wait for the current reply to finish.'
                  : confirmDelete
                    ? `Click again to delete. ${!isUser && swipes > 1 ? `Removes all ${swipes} alternatives.` : 'This can’t be undone.'}`
                    : 'Delete'
              }
              onClick={() => (confirmDelete ? onDelete(message.id) : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              onMouseLeave={() => setConfirmDelete(false)}
            >
              {confirmDelete ? 'Delete?' : <Icon name="trash" size="sm" />}
            </button>
            <Menu
              label="More: branch, hide"
              icon={<Icon name="more" size="sm" />}
              entries={moreEntries}
              className="w3-tbtn"
              popupClassName="w3-menu"
            />
          </footer>
        ) : null}
      </div>
    </article>
  );
});

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: 'refresh' | 'forward' | 'pencil' | 'copy';
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="w3-tbtn"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size="sm" />
    </button>
  );
}

/** Reveal replies: when finished. The reply streams out of sight; this counts it in. */
function WritingWhole({ stream }: { stream: StreamStore }) {
  const snapshot = useSyncExternalStore(stream.subscribe, stream.getSnapshot);
  const words = snapshot.text.trim() ? snapshot.text.trim().split(/\s+/).length : 0;
  const thinking = !snapshot.text && Boolean(snapshot.reasoning);
  return (
    <p className="w3-writing" role="status">
      <i aria-hidden="true" />
      {thinking ? 'Thinking…' : words ? `Writing · ${words} words` : 'Writing…'}
    </p>
  );
}

/** The reasoning as it arrives: faint, scrolling under a shimmering "Thinking". */
function LiveReasoning({ stream }: { stream: StreamStore }) {
  const snapshot = useSyncExternalStore(stream.subscribe, stream.getSnapshot);
  if (!snapshot.reasoning) return null;
  const thinking = !snapshot.text;
  const words = snapshot.reasoning.trim().split(/\s+/).length;
  return (
    <div className="w3-reason" data-live={thinking || undefined}>
      <span className="w3-reason__head">
        <Icon name="spark" size="sm" />
        <span className="w3-reason__label">{thinking ? 'Thinking' : 'Reasoning'}</span>
        <span className="w3-reason__n">{words} words</span>
      </span>
      {thinking ? (
        <div className="w3-reason__body">
          <span>{snapshot.reasoning}</span>
        </div>
      ) : null}
    </div>
  );
}

function resizeTextareaPreservingScroll(
  element: HTMLTextAreaElement,
  initialScrollTop?: number | null,
  keepBottomInView?: boolean,
) {
  const scroller = element.closest<HTMLElement>('.w3-transcript');
  const prevScrollTop = initialScrollTop ?? scroller?.scrollTop ?? null;
  const prevHeight = element.offsetHeight;
  element.style.height = 'auto';
  const nextHeight = element.scrollHeight;
  element.style.height = `${nextHeight}px`;
  if (!scroller || prevScrollTop === null) return;

  scroller.scrollTop = prevScrollTop;
  const container = element.closest<HTMLElement>('.w3-msg__editor, .w3-reason__edit') ?? element;
  const scrollerRect = scroller.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const limit = scrollerRect.bottom - 16;

  if (keepBottomInView && containerRect.bottom > limit) {
    scroller.scrollTop += containerRect.bottom - limit;
  } else if (
    nextHeight > prevHeight &&
    containerRect.bottom > limit &&
    containerRect.bottom - (nextHeight - prevHeight) <= limit + 8
  ) {
    scroller.scrollTop += nextHeight - prevHeight;
  }
}

function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  active: boolean,
  value: string,
  openScrollTopRef?: RefObject<number | null>,
) {
  const wasActiveRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is the trigger, read through the element
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) {
      wasActiveRef.current = false;
      return;
    }
    const opening = !wasActiveRef.current;
    wasActiveRef.current = true;
    const initialScrollTop = opening ? (openScrollTopRef?.current ?? null) : null;
    if (opening && openScrollTopRef) openScrollTopRef.current = null;
    resizeTextareaPreservingScroll(element, initialScrollTop, opening);
  }, [ref, active, value, openScrollTopRef]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return;
      lastWidth = element.clientWidth;
      resizeTextareaPreservingScroll(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
}

/** Settled reasoning: one line, opened on demand, editable while open. */
function ReasoningBlock({
  text,
  displayText,
  onEdit,
}: {
  text: string;
  displayText?: string;
  onEdit: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const openScrollTopRef = useRef<number | null>(null);
  const shown = displayText ?? text;
  const words = shown.trim() ? shown.trim().split(/\s+/).length : 0;

  useAutoGrowTextarea(editorRef, open && editing, draft, openScrollTopRef);

  function commitEdit() {
    if (draft !== text) onEdit(draft);
    setEditing(false);
  }

  return (
    <div
      ref={rootRef}
      className="w3-reason"
      data-open={open || undefined}
      data-editing-reasoning={(open && editing) || undefined}
    >
      <button
        type="button"
        className="w3-reason__head"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setEditing(false);
        }}
      >
        <Icon name="spark" size="sm" />
        <span className="w3-reason__label">Reasoning</span>
        <span className="w3-reason__n">{words} words</span>
        <Icon name="chevronDown" size="sm" />
      </button>
      {open ? (
        editing ? (
          <div className="w3-reason__edit">
            <textarea
              ref={editorRef}
              className="w3-msg__edit"
              value={draft}
              rows={1}
              aria-label="Edit reasoning"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  commitEdit();
                }
              }}
            />
            <div className="w3-msg__edit-bar">
              <span className="w3-msg__edit-hint">⌘↵ saves · Esc cancels</span>
              <div className="w3-msg__edit-acts">
                <button
                  type="button"
                  className="w3-st-ghost w3-st-ghost--sm"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
                <button type="button" className="w3-msg__save" onClick={commitEdit}>
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="w3-reason__body">
            <div className="w3-reason__text">
              <Markdown text={shown} />
            </div>
            <button
              type="button"
              className="w3-textbtn"
              data-quiet
              onClick={() => {
                const scroller = rootRef.current?.closest<HTMLElement>('.w3-transcript');
                openScrollTopRef.current = scroller ? scroller.scrollTop : null;
                setDraft(text);
                setEditing(true);
              }}
            >
              Edit reasoning
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
