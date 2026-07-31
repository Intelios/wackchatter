import { type MessageState, currentText, swipeCount } from '@shared/chat/message.ts';
import { useEffect, useRef, useState } from 'react';
import {
  BranchIcon,
  ChevronIcon,
  ChevronLeftIcon,
  ContinueIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  RefreshIcon,
  TrashIcon,
} from '../../layout/icons.tsx';
import { Markdown } from './Markdown.tsx';
import { StreamingText } from './StreamingText.tsx';
import type { StreamStore } from './state/streamStore.ts';

interface MessageBubbleProps {
  message: MessageState;
  avatarUrl: string | null;
  /** True while this message is the one being generated into. */
  streaming: boolean;
  stream: StreamStore;
  /** The final message in the transcript, which is the only one that can be acted on. */
  isLast: boolean;
  busy: boolean;
  onSwipe: (direction: -1 | 1) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  /** Generate a reply to this turn. Offered when the transcript ends on the user. */
  onRetry: () => void;
  onEdit: (text: string) => void;
  onDelete: () => void;
  onToggleHidden: () => void;
  onBranch: () => void;
}

export function MessageBubble({
  message,
  avatarUrl,
  streaming,
  stream,
  isLast,
  busy,
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
    if (draft !== text) onEdit(draft);
    setEditing(false);
  }

  const canSwipeBack = message.swipe_id > 0;
  // Swiping, regenerating and continuing all act on a reply sitting at the end of the
  // transcript. A user turn at the end means the reply is still owed — offer a retry.
  const canReply = isLast && !message.is_user;
  const canRetry = isLast && message.is_user;

  return (
    <article
      className="message"
      data-role={message.is_user ? 'user' : 'assistant'}
      data-hidden={message.is_system || undefined}
    >
      <div className="message__avatar">
        {avatarUrl && !message.is_user ? (
          <img src={avatarUrl} alt="" />
        ) : (
          <span aria-hidden="true">{message.name.slice(0, 1).toUpperCase()}</span>
        )}
      </div>

      <div className="message__body">
        <header className="message__head">
          <span className="message__name">{message.name}</span>
          {message.is_system ? (
            <span className="message__badge" title="Hidden from the prompt, shown here">
              hidden
            </span>
          ) : null}
          {info?.extra?.model ? (
            <span className="message__meta">{String(info.extra.model)}</span>
          ) : null}
          {typeof info?.extra?.token_count === 'number' ? (
            <span className="message__meta">{info.extra.token_count} tok</span>
          ) : null}
          {info?.extra?.truncated ? (
            <span className="message__badge message__badge--warn" title="Generation stopped early">
              truncated
            </span>
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
          <StreamingText store={stream} />
        ) : (
          <>
            {info?.extra?.reasoning ? (
              <details className="message__reasoning">
                <summary>Thinking</summary>
                <div className="message__reasoning-body">{String(info.extra.reasoning)}</div>
              </details>
            ) : null}
            <Markdown text={text} />
          </>
        )}

        {!editing && !streaming ? (
          <footer className="message__actions">
            {/* Only offered when the transcript ends on the user's turn. */}
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
                <button
                  type="button"
                  className="wc-button wc-button--ghost message__action"
                  onClick={() => onSwipe(-1)}
                  disabled={busy || !canSwipeBack}
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

            {canReply ? (
              <>
                <button
                  type="button"
                  className="wc-button wc-button--ghost message__action"
                  onClick={onRegenerate}
                  disabled={busy}
                  title="Regenerate — replaces this reply and its alternatives"
                  aria-label="Regenerate"
                >
                  <RefreshIcon />
                </button>
                <button
                  type="button"
                  className="wc-button wc-button--ghost message__action"
                  onClick={onContinue}
                  disabled={busy}
                  title="Continue this reply"
                  aria-label="Continue"
                >
                  <ContinueIcon />
                </button>
              </>
            ) : null}

            <button
              type="button"
              className="wc-button wc-button--ghost message__action"
              onClick={startEditing}
              title="Edit"
              aria-label="Edit"
            >
              <EditIcon />
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost message__action"
              onClick={onToggleHidden}
              title={
                message.is_system
                  ? 'Show to the model again'
                  : 'Hide from the prompt (stays in the transcript)'
              }
              aria-label={message.is_system ? 'Unhide from prompt' : 'Hide from prompt'}
            >
              {message.is_system ? <EyeOffIcon /> : <EyeIcon />}
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost message__action"
              onClick={onBranch}
              title="Start a new chat branching from here"
              aria-label="Branch from here"
            >
              <BranchIcon />
            </button>
            {/* Two-click confirm in place: destructive, but never a blocking dialog. */}
            <button
              type="button"
              className="wc-button wc-button--ghost wc-button--danger message__action"
              onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              title={confirmDelete ? 'Click again to delete' : 'Delete'}
              aria-label={confirmDelete ? 'Click again to delete' : 'Delete'}
              data-confirming={confirmDelete || undefined}
            >
              <TrashIcon />
              {confirmDelete ? <span className="message__confirm">Sure?</span> : null}
            </button>
          </footer>
        ) : null}
      </div>
    </article>
  );
}
