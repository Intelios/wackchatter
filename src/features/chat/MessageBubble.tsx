import { currentText, type MessageState, swipeCount } from '@shared/chat/message.ts';
import { isProviderId, PROVIDERS } from '@shared/providers/types.ts';
import { type CSSProperties, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronIcon,
  ChevronLeftIcon,
  EditIcon,
  PlugIcon,
  RefreshIcon,
} from '../../layout/icons.tsx';
import type { CardReaderInit } from './CardReader.tsx';
import { CardSheetPopover } from './CardSheetPopover.tsx';
import { CreatorNotesPopover } from './CreatorNotesPopover.tsx';
import { formatTimestamp } from './formatDate.ts';
import { Markdown } from './Markdown.tsx';
import { MessageMenu } from './MessageMenu.tsx';
import { Reasoning } from './Reasoning.tsx';
import { StreamingText } from './StreamingText.tsx';
import type { CardStore } from './state/cardStore.ts';
import type { GenMode } from './state/chatReducer.ts';
import type { StreamStore } from './state/streamStore.ts';
import { resolveSwipeMotion, type SwipeMotionDir } from './swipeMotion.ts';
import './MessageBubble.css';

interface MessageBubbleProps {
  message: MessageState;
  /** Already resolved for this message's speaker — the character's or the persona's. */
  avatarUrl: string | null;
  dialogueActive: boolean;
  /** Null means use the token-backed fallback. */
  dialogueColor: string | null;
  /** True while this message is the one being generated into. */
  streaming: boolean;
  /** The generation in flight, or null when idle. Lets the bubble tell a re-roll from a send. */
  mode: GenMode | null;
  stream: StreamStore;
  /** The final message in the transcript, which is the only one that can be acted on. */
  isLast: boolean;
  /** A real reply is active; structural actions cannot safely run. */
  busy: boolean;
  /** A quiet summary blocks new provider generations but not transcript interaction. */
  summaryRunning: boolean;
  /** A quiet memory extraction blocks new provider generations but not transcript interaction. */
  memoryRunning?: boolean;
  /**
   * Render-only text, for greeting macros and regex scripts. Editing still receives the
   * stored text — you edit what is saved, not what you were shown.
   */
  displayText?: string;
  /** The same split for the thinking block, which scripts can target separately. */
  displayReasoning?: string;
  /*
   * The card's creator notes, macros already resolved like `displayText`, and how many of
   * this message's swipes the card wrote. Set on the greeting row alone — passed as
   * primitives rather than a ready-made node so the memo below survives: a node would
   * change identity every render.
   */
  creatorNotes?: string;
  greetingCount?: number;
  /*
   * The open character's card, for the sheet on the avatar. A store rather than the card
   * itself, and for the same reason `stream` is one: its identity never changes, so the
   * memo below survives an editor autosave that would otherwise repaint every row on
   * screen twice a second. Absent on user rows, which get a plain avatar and no
   * affordance — a persona has no card to read.
   */
  cardStore?: CardStore;
  /** Leaves for the character editor, from inside the sheet. */
  onEditCharacter?: () => void;
  /** Hands the sheet's place to the full-width reader. */
  onOpenCardReader?: (init: CardReaderInit) => void;
  /*
   * The id-taking handlers take it as an argument rather than being closed over the
   * message in ChatView. A per-row closure would change identity on every render and
   * defeat the memo below — one stable callback for the whole transcript is the point.
   *
   * Swipe, regenerate and continue need no id: they only ever act on the last message.
   */
  onSwipe: (direction: -1 | 1) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  /** Generate a reply to this turn. Offered when the transcript ends on the user. */
  onRetry: () => void;
  onEdit: (id: string, text: string) => void;
  onEditReasoning: (id: string, reasoning: string) => void;
  onDelete: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onBranch: (id: string) => void;
}

/**
 * One turn of the conversation.
 *
 * Memoised, which only works because ChatView hoists its callbacks — inline arrows would
 * change identity every render and defeat it. Worth doing here because the row now does
 * real per-render work: a timestamp, a provider lookup, and a menu.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  avatarUrl,
  dialogueActive,
  dialogueColor,
  streaming,
  mode,
  stream,
  isLast,
  busy,
  summaryRunning,
  memoryRunning,
  displayText,
  displayReasoning,
  creatorNotes,
  greetingCount,
  cardStore,
  onEditCharacter,
  onOpenCardReader,
  onSwipe,
  onRegenerate,
  onContinue,
  onRetry,
  onEdit,
  onEditReasoning,
  onDelete,
  onToggleHidden,
  onBranch,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  /*
   * The swipe entrance animation, presentation-only.
   *
   * The body below is keyed on a bump of this state, so a new motion value remounts it
   * and replays the CSS entrance. It starts null — nothing animates on mount, which is
   * what keeps loading a chat quiet — and is set only when a transition actually looks
   * like a swipe or a re-roll (see resolveSwipeMotion). The keyed remount is also what
   * makes consecutive swipes in the same direction each animate.
   */
  const [motion, setMotion] = useState<{ n: number; dir: SwipeMotionDir } | null>(null);
  const prevSwipeRef = useRef(message.swipe_id);
  // Deliberately not seeded with the current value: a bubble that mounts already
  // streaming (a regenerate's placeholder) must read as a stream just started.
  const prevStreamingRef = useRef(false);

  // useLayoutEffect, not useEffect: the class has to land before the first paint, or
  // the swapped text shows one unanimated frame and then jumps into its `from` frame.
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

  useEffect(() => {
    // preventScroll: the pencil the user clicked is on screen, so the editor is too —
    // a plain focus() would still "reveal" the textarea and jump the transcript.
    if (editing) textarea.current?.focus({ preventScroll: true });
  }, [editing]);

  function startEditing() {
    setDraft(text);
    // The editor replaces the body; without clearing, closing it would remount the body
    // with a stale motion class and replay the last swipe's entrance for no reason.
    setMotion(null);
    setEditing(true);
  }

  function commitEdit() {
    if (draft !== text) onEdit(message.id, draft);
    setEditing(false);
  }

  const canSwipeBack = message.swipe_id > 0;
  // Swiping, regenerating and continuing all act on a reply sitting at the end of the
  // transcript. A user turn at the end means the reply is still owed — offer a retry.
  const canReply = isLast && !message.is_user;
  const canRetry = isLast && message.is_user;

  const timestamp = formatTimestamp(info?.send_date);

  /*
   * Who produced this. `extra.api` is a provider id, but MessageExtra carries an open
   * index signature by design — a chat written by a future build could hold a value this
   * one has never heard of, and indexing PROVIDERS blindly would take down the whole
   * transcript on `.label`.
   */
  const providerId = info?.extra?.api;
  const providerLabel =
    typeof providerId === 'string' && isProviderId(providerId) ? PROVIDERS[providerId].label : null;
  const provenance = [
    providerLabel,
    info?.extra?.model ? String(info.extra.model) : null,
    typeof info?.extra?.token_count === 'number' ? `${info.extra.token_count} tok` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <article
      className="message"
      data-message-id={message.id}
      data-role={message.is_user ? 'user' : 'assistant'}
      data-hidden={message.is_system || undefined}
      data-dialogue-colored={dialogueActive || undefined}
      style={
        dialogueColor ? ({ '--wc-dialogue-color': dialogueColor } as CSSProperties) : undefined
      }
    >
      <div className="message__bubble">
        <header className="message__head">
          {/* A card to read makes the avatar a control; without one it stays a picture. */}
          {cardStore ? (
            <CardSheetPopover
              store={cardStore}
              name={message.name}
              avatarUrl={avatarUrl}
              onEditCharacter={onEditCharacter}
              onOpenReader={onOpenCardReader}
              busy={busy}
            />
          ) : (
            <div className="message__avatar">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" />
              ) : (
                <span aria-hidden="true">{message.name.slice(0, 1).toUpperCase()}</span>
              )}
            </div>
          )}

          <div className="message__ident">
            <span className="message__name">{message.name}</span>
            {timestamp ? (
              <time className="message__time" dateTime={timestamp.iso} title={timestamp.full}>
                {timestamp.short}
              </time>
            ) : null}
            {/* Native title, per the house rule: same information, no new machinery. */}
            {provenance ? (
              <span className="message__provider" title={provenance}>
                <PlugIcon />
                <span className="wc-visually-hidden">{provenance}</span>
              </span>
            ) : null}
            {message.is_system ? (
              // The badge names what hid it, because "why is this greyed out?" is
              // otherwise unanswerable once a memory and a manual /hide are both in play.
              <span
                className="message__badge"
                title={
                  message.hiddenBy
                    ? 'Hidden by a memory. Deleting or revealing that memory brings it back.'
                    : 'Hidden from the prompt by hand, shown here'
                }
              >
                hidden
              </span>
            ) : null}
            {info?.extra?.truncated ? (
              <span
                className="message__badge message__badge--warn"
                title="Generation stopped early"
              >
                truncated
              </span>
            ) : null}
          </div>

          {!editing && !streaming ? (
            <div className="message__tools">
              <button
                type="button"
                className="wc-button wc-button--ghost message__action"
                onClick={startEditing}
                title="Edit"
                aria-label="Edit"
              >
                <EditIcon />
              </button>
              <MessageMenu
                state={{
                  busy,
                  summaryRunning,
                  memoryRunning,
                  isLast,
                  isUser: message.is_user,
                  isHidden: message.is_system,
                  confirmingDelete: confirmDelete,
                }}
                actions={{
                  // What you see is what you get — the scripts' and greeting macros'
                  // render, not the stored text.
                  copy: () => void navigator.clipboard.writeText(renderedText),
                  regenerate: onRegenerate,
                  continueLast: onContinue,
                  toggleHidden: () => onToggleHidden(message.id),
                  branch: () => onBranch(message.id),
                  delete: () => (confirmDelete ? onDelete(message.id) : setConfirmDelete(true)),
                }}
              />
            </div>
          ) : null}
        </header>

        {editing ? (
          <div className="message__editor">
            <textarea
              ref={textarea}
              className="wc-textarea"
              value={draft}
              rows={Math.min(20, Math.max(3, draft.split('\n').length + 1))}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setEditing(false);
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commitEdit();
              }}
            />
            <div className="message__editor-actions">
              <button type="button" className="wc-button wc-button--primary" onClick={commitEdit}>
                Save
              </button>
              <button
                type="button"
                className="wc-button wc-button--ghost"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <span className="wc-hint">⌘↵ to save, Esc to cancel</span>
            </div>
          </div>
        ) : (
          /*
           * Keyed on the motion counter so a swipe or re-roll remounts this region and
           * replays its entrance; the avatar, header and footer never move. The plain
           * wrapper is fine for useStickToBottom, which observes the transcript box — the
           * streaming leaf still sits in ordinary flow and only this region re-renders
           * while tokens arrive.
           */
          <div
            key={motion?.n}
            className={
              motion
                ? `message__body message__body--motion message__body--${motion.dir}`
                : 'message__body'
            }
          >
            {streaming ? (
              <StreamingText store={stream} />
            ) : (
              <>
                {info?.extra?.reasoning ? (
                  <Reasoning
                    text={String(info.extra.reasoning)}
                    displayText={displayReasoning}
                    onEdit={(reasoning) => onEditReasoning(message.id, reasoning)}
                  />
                ) : null}
                <Markdown text={renderedText} />
              </>
            )}
          </div>
        )}

        {!editing && !streaming ? (
          <footer className="message__foot">
            {/* Retry is the way out of a failed generation, so it is never hover-hidden. */}
            {canRetry ? (
              <button
                type="button"
                className="wc-button wc-button--ghost message__action message__action--retry"
                onClick={onRetry}
                disabled={busy || summaryRunning || memoryRunning}
                title="Generate a reply to this message"
                aria-label="Retry"
              >
                <RefreshIcon />
                Retry
              </button>
            ) : null}

            {canReply ? (
              <div className="message__swipes">
                {/*
                 * Beside the counter it explains, and only on a greeting whose card left
                 * notes — see CreatorNotesPopover for why here and not in a panel.
                 */}
                {creatorNotes?.trim() ? (
                  <CreatorNotesPopover
                    notes={creatorNotes}
                    greetingCount={greetingCount ?? swipes}
                    swipeIndex={message.swipe_id}
                  />
                ) : null}
                {/*
                 * Kept mounted and merely invisible at index 0. Unmounting it would shift
                 * the counter sideways the moment you swipe back to the first alternative,
                 * which is exactly the jitter the rest of this app avoids.
                 */}
                <button
                  type="button"
                  className="wc-button wc-button--ghost message__action"
                  onClick={() => onSwipe(-1)}
                  disabled={busy || !canSwipeBack}
                  data-invisible={!canSwipeBack || undefined}
                  aria-label="Previous alternative"
                  title="Previous alternative"
                >
                  <ChevronLeftIcon />
                </button>
                <span className="message__swipe-count">
                  {message.swipe_id + 1}/{swipes}
                </span>
                <button
                  type="button"
                  className="wc-button wc-button--ghost message__action"
                  onClick={() => onSwipe(1)}
                  disabled={
                    busy || ((summaryRunning || memoryRunning) && message.swipe_id === swipes - 1)
                  }
                  aria-label="Next alternative, or generate one"
                  title={
                    message.swipe_id === swipes - 1
                      ? 'Generate another alternative'
                      : 'Next alternative'
                  }
                >
                  <ChevronIcon />
                </button>
              </div>
            ) : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
});
