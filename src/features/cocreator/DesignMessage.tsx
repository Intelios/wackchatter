import { currentInfo, currentText, type MessageState, swipeCount } from '@shared/chat/message.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardSlot } from '@shared/types/cocreator.ts';
import { memo, useMemo, useState } from 'react';
import { ChevronIcon, ChevronLeftIcon, RefreshIcon, TrashIcon } from '../../layout/icons.tsx';
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
  streaming: boolean;
  stream: StreamStore;
  busy: boolean;
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
  streaming,
  stream,
  busy,
  countTokens,
  isFilled,
  onUse,
  onSelectSwipe,
  onReroll,
  onDelete,
}: DesignMessageProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const swipes = swipeCount(message);
  const info = currentInfo(message);
  const text = currentText(message);
  const canSwipeBack = message.swipe_id > 0;

  // Only assistant turns carry card content; a user turn is an instruction, not material.
  const parsed = useMemo(
    () => (message.is_user ? null : parseCardBlocks(text)),
    [message.is_user, text],
  );
  const hasBlocks = Boolean(parsed?.blocks.length);

  return (
    <article className="design-message" data-user={message.is_user || undefined}>
      <header className="design-message__header">
        <span className="design-message__name">
          {message.is_user ? DESIGNER_NAME : ASSISTANT_NAME}
        </span>
        {info.extra?.model ? (
          <span className="design-message__model">{String(info.extra.model)}</span>
        ) : null}
        {info.extra?.truncated ? <span className="design-message__badge">truncated</span> : null}
        <span className="design-message__spacer" />
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger design-message__action"
          data-confirming={confirmDelete}
          disabled={busy}
          onClick={() => (confirmDelete ? onDelete(message.id) : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          title={
            busy
              ? 'Generating a reply'
              : confirmDelete
                ? 'Click again to delete'
                : 'Delete this turn'
          }
          aria-label={confirmDelete ? 'Click again to delete' : 'Delete this turn'}
        >
          <TrashIcon />
        </button>
      </header>

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

      {!message.is_user && !streaming ? (
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
          {canReroll ? (
            <button
              type="button"
              className="wc-button wc-button--ghost design-message__reroll"
              onClick={onReroll}
              disabled={busy}
              title={busy ? 'Generating a reply' : 'Generate another take on this reply'}
            >
              <RefreshIcon />
              Another take
            </button>
          ) : null}

          <span className="design-message__spacer" />

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
              isFilled={isFilled}
              onUse={(slot, value) => onUse(slot, value, 'message')}
            />
          ) : null}
          <UseAsMenu
            slot={null}
            getText={() => selectionWithin(bodyEl)}
            label="Use selection as"
            busy={busy}
            isFilled={isFilled}
            requiresSelection
            onUse={(slot, value) => onUse(slot, value, 'selection')}
          />
        </footer>
      ) : null}
    </article>
  );
});
