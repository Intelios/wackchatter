/**
 * One turn of a Co-Creator conversation, in the 3.0 shell.
 *
 * A reply's card blocks each say which field they are for, so a block's first button puts
 * it there in one click. Into a field that already holds something it never overwrites
 * blind: it opens the compare on the card instead. The ⋯ beside it sends the block to any
 * other field, and a selection inside the message can be filed or quoted to the side chat.
 *
 * Block affordances only exist on a settled turn: while a reply streams its text lives in
 * the stream store, never in React state, exactly as in the chat.
 */

import { currentInfo, currentText, type MessageState, swipeCount } from '@shared/chat/message.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { isFilteredStop } from '@shared/providers/sse.ts';
import type { CardSlot } from '@shared/types/cocreator.ts';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Menu } from '../components/Menu.tsx';
import { Markdown } from '../features/chat/Markdown.tsx';
import { Reasoning } from '../features/chat/Reasoning.tsx';
import { StreamingText } from '../features/chat/StreamingText.tsx';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import { type CardBlock, parseCardBlocks, SLOT_LABELS } from '../features/cocreator/blocks.ts';
import { buildUseAsMenu, type GreetingTarget } from '../features/cocreator/useAsMenu.ts';
import { Icon } from './icons.tsx';

export type UseSource = 'block' | 'message' | 'selection';

/** Where filed text goes: straight in, or to the compare when it would replace something. */
export interface FileActions {
  greetings: readonly GreetingTarget[];
  onReplaceGreeting: (id: string, text: string, source: UseSource) => void;
  /** Whether a single-value field already holds something. */
  isFilled: (slot: CardSlot) => boolean;
  /** The text a field holds now, to tell "already in the card" apart. */
  keptText: (slot: CardSlot) => string | null;
  onUse: (slot: CardSlot, text: string, source: UseSource, label?: string) => void;
  /** Ask before replacing: the card shows both versions. */
  onCompare: (slot: CardSlot, text: string, source: UseSource, label?: string) => void;
}

function selectionWithin(root: HTMLElement | null): string {
  if (!root) return '';
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return '';
  return selection.toString().trim();
}

/** "Use as Description", or "Add as a greeting" where filing appends. */
function fileLabel(slot: CardSlot, filled: boolean): string {
  if (slot === 'alternate_greeting') return 'Add as a greeting';
  if (slot === 'tags') return 'Add the tags';
  return `${filled ? 'Replace' : 'Use as'} ${SLOT_LABELS[slot]}`;
}

/** The ⋯ beside a block, or "Use selection as": every field, replacing costs a second click. */
function FileMenu({
  slot,
  getText,
  label,
  icon,
  busy,
  busyReason,
  requiresSelection,
  files,
  onFile,
}: {
  slot: CardSlot | null;
  getText: () => string;
  label: string;
  icon: ReactNode;
  busy: boolean;
  busyReason: string;
  requiresSelection?: boolean;
  files: FileActions;
  onFile: (slot: CardSlot, text: string) => void;
}) {
  const [confirming, setConfirming] = useState<CardSlot | null>(null);
  const [text, setText] = useState('');
  const entries = buildUseAsMenu(
    {
      slot,
      text,
      busy,
      busyReason,
      filled: files.isFilled,
      confirming,
      ...(requiresSelection ? { requiresSelection } : {}),
      greetings: files.greetings,
    },
    {
      onUse: (target) => {
        setConfirming(null);
        if (files.isFilled(target))
          files.onCompare(
            target,
            text,
            requiresSelection ? 'selection' : slot ? 'block' : 'message',
          );
        else onFile(target, text);
      },
      onArmConfirm: setConfirming,
      onReplaceGreeting: (id) =>
        files.onReplaceGreeting(
          id,
          text,
          requiresSelection ? 'selection' : slot ? 'block' : 'message',
        ),
    },
  );
  return (
    <Menu
      label={label}
      icon={icon}
      entries={entries}
      className="w3-co-menu"
      popupClassName="w3-menu"
      placement="bottom-end"
      onOpenChange={(open) => {
        if (open) setText(getText());
        else setConfirming(null);
      }}
    />
  );
}

function BlockView({
  block,
  busy,
  busyReason,
  countTokens,
  files,
}: {
  block: CardBlock;
  busy: boolean;
  busyReason: string;
  countTokens: TokenCounter;
  files: FileActions;
}) {
  const slot = block.slot;
  const text = block.text.trim();
  const kept = slot ? files.keptText(slot) : null;
  const inCard =
    slot === 'alternate_greeting'
      ? files.greetings.some(
          (greeting) => greeting.label !== 'First message' && greeting.text.trim() === text,
        )
      : Boolean(slot && kept !== null && kept.trim() === text);
  const filled = slot ? files.isFilled(slot) : false;
  const label = slot ? SLOT_LABELS[slot] : block.label || 'Unlabelled';
  return (
    <div className="w3-co-block" data-in-card={inCard || undefined}>
      <div className="w3-co-block__head">
        <span>{label}</span>
        {slot ? null : <span className="w3-co-block__odd">not a card field</span>}
        <span className="w3-co-block__n">
          {countTokens.countText(text).toLocaleString()} tokens
        </span>
      </div>
      <div className="w3-co-block__text">
        <Markdown text={block.text} />
      </div>
      {block.closed ? (
        <div className="w3-co-block__acts">
          {inCard ? (
            <span className="w3-co-block__kept">
              <Icon name="check" size="xs" />
              In the card
            </span>
          ) : slot ? (
            <button
              type="button"
              className="w3-st-pill w3-co-pill"
              disabled={busy || !text}
              title={busy ? busyReason : undefined}
              onClick={() =>
                filled ? files.onCompare(slot, text, 'block') : files.onUse(slot, text, 'block')
              }
            >
              {fileLabel(slot, filled)}
            </button>
          ) : null}
          <FileMenu
            slot={slot}
            getText={() => text}
            label={slot ? 'Use it somewhere else' : 'Use as'}
            icon={slot ? <Icon name="more" size="sm" /> : <span>Use as…</span>}
            busy={busy}
            busyReason={busyReason}
            files={files}
            onFile={(target, value) =>
              files.onUse(target, value, 'block', block.slot ? undefined : block.label)
            }
          />
        </div>
      ) : null}
    </div>
  );
}

export const CoCreatorMessage = memo(function CoCreatorMessage({
  message,
  who,
  canReroll,
  canRetry,
  streaming,
  stream,
  busy,
  busyReason,
  blockedReason = null,
  countTokens,
  files,
  onAskSide,
  onInsert,
  onSelectSwipe,
  onReroll,
  onRetry,
  onContinue,
  onEdit,
  onDelete,
}: {
  message: MessageState;
  /** The other speaker's name: the Co-Creator, or the side chat. */
  who: string;
  canReroll: boolean;
  canRetry: boolean;
  streaming: boolean;
  stream: StreamStore;
  busy: boolean;
  busyReason: string;
  blockedReason?: string | null;
  countTokens: TokenCounter;
  files: FileActions;
  onAskSide?: (text: string) => void;
  /** In the side chat: put text into the main conversation's draft. */
  onInsert?: (text: string) => void;
  onSelectSwipe: (id: string, index: number) => void;
  onReroll: () => void;
  onRetry: () => void;
  onContinue: () => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [armed, setArmed] = useState(false);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  const text = currentText(message);
  const info = currentInfo(message);
  const swipes = swipeCount(message);
  const filtered = isFilteredStop(info.extra?.finish_reason);

  useEffect(() => {
    if (editing) editRef.current?.focus({ preventScroll: true });
  }, [editing]);
  useEffect(() => {
    const update = () => setSelected(selectionWithin(body));
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [body]);

  const parsed = useMemo(
    () => (message.is_user ? null : parseCardBlocks(text)),
    [message.is_user, text],
  );
  const hasBlocks = Boolean(parsed?.blocks.length);
  const getSelection = useCallback(() => selectionWithin(body), [body]);
  const commit = () => {
    if (draft !== text) onEdit(message.id, draft);
    setEditing(false);
  };

  return (
    <article
      className="w3-co-msg"
      data-me={message.is_user || undefined}
      // The transcript window finds its rows by this attribute.
      data-message-id={message.id}
    >
      {message.is_user ? null : (
        <header className="w3-co-msg__who">
          <span className="w3-co-msg__mark">
            <Icon name="spark" size="xs" />
          </span>
          <b>{who}</b>
          {info.extra?.model ? <span>{String(info.extra.model)}</span> : null}
          {info.extra?.truncated ? (
            <span className="w3-co-msg__flag" title="The reply ended early. What arrived is kept.">
              Cut short
            </span>
          ) : filtered ? (
            <span
              className="w3-co-msg__flag"
              title="The provider's safety filter stopped this reply mid-sentence. The tokens spent were billed, and continuing will not get past it — try another model for this content."
            >
              Filtered
            </span>
          ) : null}
          {swipes > 1 && !streaming ? (
            <span className="w3-co-swipe">
              <button
                type="button"
                aria-label="Previous take"
                disabled={busy || message.swipe_id === 0}
                onClick={() => onSelectSwipe(message.id, message.swipe_id - 1)}
              >
                <Icon name="chevronLeft" size="xs" />
              </button>
              {message.swipe_id + 1} / {swipes}
              <button
                type="button"
                aria-label="Next take"
                disabled={busy || message.swipe_id === swipes - 1}
                onClick={() => onSelectSwipe(message.id, message.swipe_id + 1)}
              >
                <Icon name="chevronRight" size="xs" />
              </button>
            </span>
          ) : null}
        </header>
      )}

      {editing ? (
        <div className="w3-co-edit">
          <textarea
            ref={editRef}
            value={draft}
            rows={Math.min(20, Math.max(3, draft.split('\n').length + 1))}
            aria-label="Edit this turn"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false);
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commit();
            }}
          />
          <div className="w3-co-edit__acts">
            <button type="button" className="w3-st-pill w3-co-pill" onClick={commit}>
              Save
            </button>
            <button
              type="button"
              className="w3-st-ghost w3-st-ghost--sm"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <span>⌘↵ saves · Esc cancels</span>
          </div>
        </div>
      ) : (
        <div className={message.is_user ? 'w3-co-msg__bubble' : 'w3-co-msg__body'} ref={setBody}>
          {streaming ? (
            <StreamingText store={stream} />
          ) : (
            <>
              {info.extra?.reasoning ? <Reasoning text={String(info.extra.reasoning)} /> : null}
              {parsed ? (
                parsed.parts.map((part, index) =>
                  part.kind === 'prose' ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
                    <Markdown key={`p${index}`} text={part.text} />
                  ) : (
                    <BlockView
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
                      key={`b${index}`}
                      block={part.block}
                      busy={busy}
                      busyReason={busyReason}
                      countTokens={countTokens}
                      files={files}
                    />
                  ),
                )
              ) : (
                <Markdown text={text} />
              )}
            </>
          )}
        </div>
      )}

      {!streaming && !editing ? (
        <footer className="w3-co-msg__tools">
          {message.is_user && canRetry ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy || Boolean(blockedReason)}
              title={busy ? busyReason : (blockedReason ?? undefined)}
            >
              <Icon name="refresh" size="xs" />
              Get a reply
            </button>
          ) : null}
          {!message.is_user && canReroll ? (
            <button
              type="button"
              onClick={onReroll}
              disabled={busy || Boolean(blockedReason)}
              title={busy ? busyReason : (blockedReason ?? undefined)}
            >
              <Icon name="refresh" size="xs" />
              Another take
            </button>
          ) : null}
          {!message.is_user && canReroll && info.extra?.truncated && !filtered ? (
            <button
              type="button"
              onClick={onContinue}
              disabled={busy || Boolean(blockedReason)}
              title={busy ? busyReason : (blockedReason ?? undefined)}
            >
              <Icon name="chevronRight" size="xs" />
              Continue
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setDraft(text);
              setEditing(true);
            }}
            disabled={busy}
          >
            <Icon name="pencil" size="xs" />
            Edit
          </button>
          <button type="button" onClick={() => void navigator.clipboard.writeText(text)}>
            <Icon name="copy" size="xs" />
            Copy
          </button>
          <button
            type="button"
            data-armed={armed || undefined}
            disabled={busy}
            onClick={() => (armed ? onDelete(message.id) : setArmed(true))}
            onBlur={() => setArmed(false)}
          >
            <Icon name="trash" size="xs" />
            {armed ? 'Click again to delete' : 'Delete'}
          </button>
          <span className="w3-co-msg__gap" />
          {onInsert && !message.is_user ? (
            <button type="button" onClick={() => onInsert(selected || text)}>
              {selected ? 'Selection to the main draft' : 'To the main draft'}
            </button>
          ) : null}
          {onAskSide && selected ? (
            <button
              type="button"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onAskSide(selected)}
            >
              Ask the side chat
            </button>
          ) : null}
          {!message.is_user ? (
            <FileMenu
              slot={null}
              getText={hasBlocks ? getSelection : () => selected || text}
              label={
                hasBlocks
                  ? 'Use the selection as'
                  : selected
                    ? 'Use the selection as'
                    : 'Use the reply as'
              }
              icon={<span>{hasBlocks || selected ? 'Use selection as…' : 'Use reply as…'}</span>}
              busy={busy}
              busyReason={busyReason}
              requiresSelection={hasBlocks}
              files={files}
              onFile={(slot, value) =>
                files.onUse(slot, value, hasBlocks || selected ? 'selection' : 'message')
              }
            />
          ) : null}
        </footer>
      ) : null}
    </article>
  );
});
