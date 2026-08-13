import { stashedSlotCount } from '@shared/cocreator/stash.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import {
  type CardSlot,
  type CardStash,
  SINGLE_SLOTS,
  type SingleCardSlot,
  type StashEntry,
} from '@shared/types/cocreator.ts';
import type { ReactNode } from 'react';
import { SLOT_LABELS } from './blocks.ts';
import { StashSlotRow } from './StashSlotRow.tsx';

interface StashPanelProps {
  stash: CardStash;
  countTokens: TokenCounter;
  busy: boolean;
  onEditSlot: (slot: SingleCardSlot, text: string) => void;
  onEditGreeting: (index: number, text: string) => void;
  onMoveGreeting: (from: number, to: number) => void;
  onRemoveGreeting: (index: number) => void;
  onRemoveTag: (index: number) => void;
  onClearSlot: (slot: CardSlot) => void;
  onShowModel: () => void;
  onFinish: () => void;
  finishing: boolean;
  /** The artwork drop target — part of the card, so it lives with the rest of it. */
  avatarSlot: ReactNode;
}

function totalTokens(stash: CardStash, count: TokenCounter): number {
  let total = 0;
  for (const slot of SINGLE_SLOTS) {
    const entry = stash[slot];
    if (entry?.text) total += count.countText(entry.text);
  }
  for (const entry of stash.alternate_greetings) total += count.countText(entry.text);
  for (const entry of stash.tags) total += count.countText(entry.text);
  return total;
}

/** "from take 2 · gpt-5.6-sol", or nothing when the origin was not recorded. */
function provenanceLabel(entry: StashEntry): string {
  const parts: string[] = [];
  if (entry.edited) parts.push('edited');
  if (entry.provenance.messageId) parts.push(`take ${entry.provenance.swipeIndex + 1}`);
  if (entry.provenance.source === 'selection') parts.push('selection');
  if (entry.provenance.model) parts.push(entry.provenance.model);
  return parts.join(' · ');
}

/**
 * The card so far.
 *
 * Everything here got here because the user clicked "Use as". Nothing in this panel was
 * written by a model directly, and nothing in it is sent back to one — the stash is an
 * editorial decision, not conversational context.
 */
export function StashPanel({
  stash,
  countTokens,
  busy,
  onEditSlot,
  onEditGreeting,
  onMoveGreeting,
  onRemoveGreeting,
  onRemoveTag,
  onClearSlot,
  onShowModel,
  onFinish,
  finishing,
  avatarSlot,
}: StashPanelProps) {
  const filled = stashedSlotCount(stash);
  const tokens = totalTokens(stash, countTokens);
  const greetings = stash.alternate_greetings;

  return (
    <aside className="stash-panel" aria-label="Card so far">
      <header className="stash-panel__header">
        <h2>Card so far</h2>
        <span className="stash-panel__count">
          {filled === 0 ? 'empty' : `${filled} ${filled === 1 ? 'slot' : 'slots'} · ${tokens} tok`}
        </span>
      </header>

      <div className="stash-panel__body">
        {avatarSlot}

        {filled === 0 ? (
          <p className="wc-empty stash-panel__empty">
            Nothing filed yet. When the assistant writes something you want, use its
            <strong> Use as </strong> button to put it here.
          </p>
        ) : null}

        {SINGLE_SLOTS.map((slot) => {
          const entry = stash[slot];
          if (!entry?.text) return null;
          return (
            <StashSlotRow
              key={slot}
              label={SLOT_LABELS[slot]}
              text={entry.text}
              meta={provenanceLabel(entry)}
              tokens={countTokens.countText(entry.text)}
              busy={busy}
              onCommit={(next) => onEditSlot(slot, next)}
              onClear={() => onClearSlot(slot)}
            />
          );
        })}

        {greetings.length > 0 ? (
          <div className="stash-panel__group">
            <div className="stash-panel__group-header">
              <span>{SLOT_LABELS.alternate_greeting}s</span>
              <span className="stash-panel__count">{greetings.length}</span>
              <button
                type="button"
                className="wc-button wc-button--ghost"
                onClick={() => onClearSlot('alternate_greeting')}
                disabled={busy}
                title="Clear every alternate greeting"
              >
                Clear all
              </button>
            </div>
            {/*
             * Order is semantic, not cosmetic: `greetingMessage` turns
             * [first_mes, ...alternate_greetings] into the opening message's swipes in
             * exactly this order, so moving one here changes what the reader swipes into.
             */}
            {greetings.map((entry, index) => (
              <StashSlotRow
                key={entry.id}
                label={`#${index + 1}`}
                text={entry.text}
                meta={provenanceLabel(entry)}
                tokens={countTokens.countText(entry.text)}
                busy={busy}
                onCommit={(next) => onEditGreeting(index, next)}
                onClear={() => onRemoveGreeting(index)}
                onMoveUp={index > 0 ? () => onMoveGreeting(index, index - 1) : undefined}
                onMoveDown={
                  index < greetings.length - 1 ? () => onMoveGreeting(index, index + 1) : undefined
                }
              />
            ))}
          </div>
        ) : null}

        {stash.tags.length > 0 ? (
          <div className="stash-panel__group">
            <div className="stash-panel__group-header">
              <span>{SLOT_LABELS.tags}</span>
              <span className="stash-panel__count">{stash.tags.length}</span>
              <button
                type="button"
                className="wc-button wc-button--ghost"
                onClick={() => onClearSlot('tags')}
                disabled={busy}
                title="Clear every tag"
              >
                Clear all
              </button>
            </div>
            <div className="stash-panel__tags">
              {stash.tags.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  className="stash-panel__tag"
                  onClick={() => onRemoveTag(index)}
                  disabled={busy}
                  title={`Remove “${entry.text}”`}
                >
                  {entry.text}
                  <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <footer className="stash-panel__footer">
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={onShowModel}
          disabled={busy || filled === 0}
          title={
            filled === 0
              ? 'Nothing is filed yet'
              : 'Add a visible turn showing the assistant what is filed so far'
          }
        >
          Show the assistant
        </button>
        <button
          type="button"
          className="wc-button wc-button--primary"
          onClick={onFinish}
          disabled={busy || finishing || filled === 0}
          title={
            filled === 0
              ? 'Fill at least one field first'
              : 'Create the card and open it in the Studio'
          }
        >
          {finishing ? 'Creating…' : 'Finish → Studio'}
        </button>
      </footer>
    </aside>
  );
}
