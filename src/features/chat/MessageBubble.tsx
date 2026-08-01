import { type MessageState, currentText, swipeCount } from '@shared/chat/message.ts';
import { PROVIDERS, isProviderId } from '@shared/providers/types.ts';
import { memo, useEffect, useRef, useState } from 'react';
import {
  ChevronIcon,
  ChevronLeftIcon,
  EditIcon,
  PlugIcon,
  RefreshIcon,
} from '../../layout/icons.tsx';
import { Markdown } from './Markdown.tsx';
import { MessageMenu } from './MessageMenu.tsx';
import { Reasoning } from './Reasoning.tsx';
import { StreamingText } from './StreamingText.tsx';
import { formatTimestamp } from './formatDate.ts';
import type { StreamStore } from './state/streamStore.ts';
import './MessageBubble.css';

interface MessageBubbleProps {
  message: MessageState;
  /** Already resolved for this message's speaker — the character's or the persona's. */
  avatarUrl: string | null;
  /** True while this message is the one being generated into. */
  streaming: boolean;
  stream: StreamStore;
  /** The final message in the transcript, which is the only one that can be acted on. */
  isLast: boolean;
  busy: boolean;
  /** Render-only text, used for raw greeting macros. Editing still receives stored text. */
  displayText?: string;
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
  streaming,
  stream,
  isLast,
  busy,
  displayText,
  onSwipe,
  onRegenerate,
  onContinue,
  onRetry,
  onEdit,
  onDelete,
  onToggleHidden,
  onBranch,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const text = currentText(message);
  const renderedText = displayText ?? text;
  const swipes = swipeCount(message);
  const info = message.swipe_info[message.swipe_id];

  useEffect(() => {
    if (editing) textarea.current?.focus();
  }, [editing]);

  function startEditing() {
    setDraft(text);
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
      data-role={message.is_user ? 'user' : 'assistant'}
      data-hidden={message.is_system || undefined}
    >
      <div className="message__bubble">
        <header className="message__head">
          <div className="message__avatar">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" />
            ) : (
              <span aria-hidden="true">{message.name.slice(0, 1).toUpperCase()}</span>
            )}
          </div>

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
              <span className="message__badge" title="Hidden from the prompt, shown here">
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
                  isLast,
                  isUser: message.is_user,
                  isHidden: message.is_system,
                  confirmingDelete: confirmDelete,
                }}
                actions={{
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
        ) : streaming ? (
          // Must stay an ordinary child: useStickToBottom follows the transcript by
          // observing its box, and only this leaf re-renders while tokens arrive.
          <StreamingText store={stream} />
        ) : (
          <>
            {info?.extra?.reasoning ? <Reasoning text={String(info.extra.reasoning)} /> : null}
            <Markdown text={renderedText} />
          </>
        )}

        {!editing && !streaming ? (
          <footer className="message__foot">
            {/* Retry is the way out of a failed generation, so it is never hover-hidden. */}
            {canRetry ? (
              <button
                type="button"
                className="wc-button wc-button--ghost message__action message__action--retry"
                onClick={onRetry}
                disabled={busy}
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
                  disabled={busy}
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
