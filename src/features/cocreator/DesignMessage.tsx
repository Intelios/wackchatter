import { currentInfo, currentText, type MessageState, swipeCount } from '@shared/chat/message.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardSlot } from '@shared/types/cocreator.ts';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronIcon,
  ChevronLeftIcon,
  CopyIcon,
  EditIcon,
  RefreshIcon,
  TrashIcon,
} from '../../layout/icons.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import { Reasoning } from '../chat/Reasoning.tsx';
import { StreamingText } from '../chat/StreamingText.tsx';
import type { StreamStore } from '../chat/state/streamStore.ts';
import { parseCardBlocks } from './blocks.ts';
import { CardBlockView } from './CardBlockView.tsx';
import { ASSISTANT_NAME, DESIGNER_NAME } from './state/cocreatorReducer.ts';
import { UseAsMenu } from './UseAsMenu.tsx';

export interface DesignMessageProps {
  message: MessageState;
  /** The last turn, and an assistant one: the only message that can be re-rolled. */
  canReroll: boolean;
  /** The last turn, and a user one: a reply is still owed after it. */
  canRetry: boolean;
  streaming: boolean;
  stream: StreamStore;
  busy: boolean;
  busyReason?: string;
  onAskSide?: (text: string) => void;
  onInsert?: (text: string) => void;
  countTokens: TokenCounter;
  isFilled: (slot: CardSlot) => boolean;
  onUse: (
    slot: CardSlot,
    text: string,
    source: 'block' | 'message' | 'selection',
    label?: string,
  ) => void;
  onSelectSwipe: (id: string, index: number) => void;
  onReroll: () => void;
  onRetry: () => void;
  onContinue: () => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}

/**
 * Read the user's current selection, if it lies inside this message.
 *
 * Scoped to the element so a selection made in another turn — or in the stash panel — cannot
 * be filed as if it came from here, which would attach the wrong provenance.
 */
function selectionWithin(root: HTMLElement | null): string {
  if (!root) return '';
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return '';
  return selection.toString().trim();
}

/**
 * One turn of the design conversation.
 *
 * Block affordances appear only on a *settled* message. While a reply streams the body is
 * `StreamingText`, exactly as in chat, because parsing per frame would require the growing
 * text in React state — which is the one thing the streaming design forbids. Nothing is
 * lost: you cannot click "Use as" on text that is still arriving.
 */
export const DesignMessage = memo(function DesignMessage({
  message,
  canReroll,
  canRetry,
  streaming,
  stream,
  busy,
  busyReason = 'Generating a reply',
  onAskSide,
  onInsert,
  countTokens,
  isFilled,
  onUse,
  onSelectSwipe,
  onReroll,
  onRetry,
  onContinue,
  onEdit,
  onDelete,
}: DesignMessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const swipes = swipeCount(message);
  const info = currentInfo(message);
  const text = currentText(message);
  const canSwipeBack = message.swipe_id > 0;

  useEffect(() => {
    if (editing) textarea.current?.focus({ preventScroll: true });
  }, [editing]);

  useEffect(() => {
    const update = () => setSelectedText(selectionWithin(bodyEl));
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [bodyEl]);

  function startEditing() {
    setDraft(text);
    setEditing(true);
  }

  function commitEdit() {
    if (draft !== text) onEdit(message.id, draft);
    setEditing(false);
  }

  // Only assistant turns carry card content; a user turn is an instruction, not material.
  const parsed = useMemo(
    () => (message.is_user ? null : parseCardBlocks(text)),
    [message.is_user, text],
  );
  const hasBlocks = Boolean(parsed?.blocks.length);

  return (
    <article
      className="design-message"
      data-user={message.is_user || undefined}
      // The window's scroll anchor finds its rows by this attribute.
      data-message-id={message.id}
    >
      <header className="design-message__header">
        <span className="design-message__name">
          {message.is_user ? DESIGNER_NAME : ASSISTANT_NAME}
        </span>
        {info.extra?.model ? (
          <span className="design-message__model">{String(info.extra.model)}</span>
        ) : null}
        {info.extra?.truncated ? (
          <span
            className="design-message__badge"
            title="The reply ended early. Its received text has been saved."
          >
            incomplete
          </span>
        ) : null}
        <span className="design-message__spacer" />
        {onAskSide && !streaming && !editing ? (
          <button
            type="button"
            className="wc-button wc-button--ghost"
            disabled={!selectedText}
            title={
              selectedText ? 'Quote selection in side chat' : 'Select text in this message first'
            }
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onAskSide(selectedText)}
          >
            Ask in side chat
          </button>
        ) : null}
        {!editing ? (
          <>
            <button
              type="button"
              className="wc-button wc-button--ghost design-message__action"
              onClick={startEditing}
              disabled={busy}
              title={busy ? busyReason : 'Edit this turn'}
              aria-label="Edit"
            >
              <EditIcon />
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost design-message__action"
              onClick={() => void navigator.clipboard.writeText(text)}
              title="Copy text"
              aria-label="Copy text"
            >
              <CopyIcon />
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost wc-button--danger design-message__action"
              data-confirming={confirmDelete}
              disabled={busy}
              onClick={() => (confirmDelete ? onDelete(message.id) : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              title={
                busy ? busyReason : confirmDelete ? 'Click again to delete' : 'Delete this turn'
              }
              aria-label={confirmDelete ? 'Click again to delete' : 'Delete this turn'}
            >
              <TrashIcon />
            </button>
          </>
        ) : null}
      </header>

      {editing ? (
        <div className="design-message__editor">
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
          <div className="design-message__editor-actions">
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
        <div className="design-message__body" ref={setBodyEl}>
          {streaming ? (
            <StreamingText store={stream} />
          ) : (
            <>
              {info.extra?.reasoning ? <Reasoning text={String(info.extra.reasoning)} /> : null}
              {parsed ? (
                parsed.parts.map((part, index) =>
                  part.kind === 'prose' ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
                    <Markdown key={`prose-${index}`} text={part.text} />
                  ) : (
                    <CardBlockView
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
                      key={`block-${index}`}
                      block={part.block}
                      busy={busy}
                      busyReason={busyReason}
                      countTokens={countTokens}
                      isFilled={isFilled}
                      onUse={(slot, blockText) =>
                        onUse(
                          slot,
                          blockText,
                          'block',
                          part.block.slot ? undefined : part.block.label,
                        )
                      }
                      onInsert={onInsert}
                    />
                  ),
                )
              ) : (
                /*
                 * `Markdown`'s default class, deliberately. Prose typography — paragraph
                 * rhythm, emphasis colour, the scrolling `pre`, the inline-code chip — is the
                 * same problem on both surfaces, and a second copy would drift silently.
                 */
                <Markdown text={text} />
              )}
            </>
          )}
        </div>
      )}

      {/*
       * A trailing user turn is owed a reply — its generation failed or was aborted empty,
       * or the reply was deleted afterwards. Retry is the way back in, and like chat it is
       * never hover-hidden: it must be findable exactly when things went wrong.
       */}
      {message.is_user && canRetry && !streaming && !editing ? (
        <footer className="design-message__footer">
          <button
            type="button"
            className="wc-button wc-button--ghost design-message__retry"
            onClick={onRetry}
            disabled={busy}
            title={busy ? busyReason : 'Generate a reply to this message'}
            aria-label="Retry"
          >
            <RefreshIcon />
            Retry
          </button>
        </footer>
      ) : null}

      {!message.is_user && !streaming && !editing ? (
        <footer className="design-message__footer">
          {swipes > 1 ? (
            <div className="design-message__swipes">
              {/*
               * Kept mounted and merely invisible at index 0, so the counter never shifts
               * sideways when you swipe back to the first take.
               */}
              <button
                type="button"
                className="wc-button wc-button--ghost design-message__action"
                onClick={() => onSelectSwipe(message.id, message.swipe_id - 1)}
                disabled={busy || !canSwipeBack}
                data-invisible={!canSwipeBack || undefined}
                aria-label="Previous take"
                title="Previous take"
              >
                <ChevronLeftIcon />
              </button>
              <span className="design-message__swipe-count">
                {message.swipe_id + 1}/{swipes}
              </span>
              <button
                type="button"
                className="wc-button wc-button--ghost design-message__action"
                onClick={() => onSelectSwipe(message.id, message.swipe_id + 1)}
                disabled={busy || message.swipe_id === swipes - 1}
                data-invisible={message.swipe_id === swipes - 1 || undefined}
                aria-label="Next take"
                title="Next take"
              >
                <ChevronIcon />
              </button>
            </div>
          ) : null}

          {/*
           * An explicit button rather than chat's overswipe-off-the-end, because in a design
           * tool "give me another one of these" is the primary move, not a discovery. It
           * works from any take — the reducer records which one to return to if it fails.
           */}
          {canReroll && info.extra?.truncated ? (
            <button
              type="button"
              className="wc-button wc-button--ghost"
              onClick={onContinue}
              disabled={busy}
              title="Request the remaining text. Keeps this take and saves the continued answer as another take."
            >
              Continue reply
            </button>
          ) : null}
          {canReroll ? (
            <button
              type="button"
              className="wc-button wc-button--ghost design-message__reroll"
              onClick={onReroll}
              disabled={busy}
              title={busy ? busyReason : 'Generate another take on this reply'}
            >
              <RefreshIcon />
              Another take
            </button>
          ) : null}

          <span className="design-message__spacer" />
          {onInsert ? (
            <>
              <button
                type="button"
                className="wc-button wc-button--ghost"
                onClick={() => onInsert(text)}
              >
                Insert into main draft
              </button>
              <button
                type="button"
                className="wc-button wc-button--ghost"
                disabled={!selectedText}
                title={
                  selectedText
                    ? 'Append selection to main draft'
                    : 'Select text in this message first'
                }
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onInsert(selectedText)}
              >
                Insert selection
              </button>
            </>
          ) : null}

          {/*
           * The fallbacks, for when the model ignored the block contract or you want one
           * paragraph out of a longer answer. Filing the whole message is offered only when
           * there are no blocks — with blocks present it would almost always be the wrong
           * choice, since it would carry the surrounding commentary into the card.
           */}
          {!hasBlocks ? (
            <UseAsMenu
              slot={null}
              getText={() => text}
              label="Use message as"
              busy={busy}
              busyReason={busyReason}
              isFilled={isFilled}
              onUse={(slot, value) => onUse(slot, value, 'message')}
            />
          ) : null}
          <UseAsMenu
            slot={null}
            getText={() => selectionWithin(bodyEl)}
            label="Use selection as"
            busy={busy}
            busyReason={busyReason}
            isFilled={isFilled}
            requiresSelection
            onUse={(slot, value) => onUse(slot, value, 'selection')}
          />
        </footer>
      ) : null}
    </article>
  );
});
