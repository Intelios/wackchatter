/**
 * The card as it is being built: what you kept so far, as it will read.
 *
 * Everything here got here because you chose it. Each written field reads at its own size
 * and can be edited or emptied in place; an empty one folds to a line that asks the
 * Co-Creator for it. Filing over a field that already holds something opens the compare at
 * the top first: both versions side by side, the words that differ marked, and you choose.
 */

import type { DraftChoices, DraftField, DraftValue } from '@shared/cocreator/draft.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import {
  type CardSlot,
  type CardStash,
  type CocreatorCardBaseline,
  SINGLE_SLOTS,
  type SingleCardSlot,
} from '@shared/types/cocreator.ts';
import { type ReactNode, useRef, useState } from 'react';
import { SLOT_LABELS } from '../features/cocreator/blocks.ts';
import type { FinishConflictError } from '../features/cocreator/finish.ts';
import { cropToCardRatio } from '../features/studio/AvatarStudio.tsx';
import { characterApi, cocreatorApi } from '../lib/api.ts';
import { cardFields, type DiffPart, filledCount, MAIN_FIELD_COUNT, wordDiff } from './cocreator.ts';
import { Icon } from './icons.tsx';

export interface Pending {
  slot: CardSlot;
  text: string;
  source: 'block' | 'message' | 'selection';
  label?: string;
  greetingId?: string;
  targetLabel?: string;
}

export interface CardEdits {
  editSlot: (slot: SingleCardSlot, text: string) => void;
  editGreeting: (index: number, text: string) => void;
  moveGreeting: (from: number, to: number) => void;
  removeGreeting: (index: number) => void;
  removeTag: (index: number) => void;
  clearSlot: (slot: CardSlot) => void;
}

const ALWAYS: readonly SingleCardSlot[] = [
  'description',
  'personality',
  'scenario',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
];

function readableValue(value: DraftValue): string {
  return Array.isArray(value)
    ? value.map((text, index) => `${index + 1}. ${text}`).join('\n\n') || '(empty)'
    : value || '(empty)';
}

function Diff({ parts, mark }: { parts: DiffPart[]; mark: 'del' | 'ins' }) {
  return (
    <>
      {parts.map((part, index) =>
        part.changed ? (
          mark === 'del' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
            <del key={index}>{part.text}</del>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
            <ins key={index}>{part.text}</ins>
          )
        ) : (
          part.text
        ),
      )}
    </>
  );
}

function Compare({
  pending,
  kept,
  onKeep,
  onUse,
}: {
  pending: Pending;
  kept: string;
  onKeep: () => void;
  onUse: () => void;
}) {
  const diff = wordDiff(kept, pending.text);
  return (
    <div className="w3-co-cmp">
      <div className="w3-co-cmp__head">
        <Icon name="pencil" size="xs" />
        <span>
          <b>{pending.targetLabel ?? SLOT_LABELS[pending.slot]}</b> is already in the card. Keep it,
          or use the new one?
        </span>
      </div>
      <div className="w3-co-cmp__two">
        <div className="w3-co-cmp__side">
          <small>In the card</small>
          <p>
            <Diff parts={diff.before} mark="del" />
          </p>
        </div>
        <div className="w3-co-cmp__side">
          <small>New</small>
          <p>
            <Diff parts={diff.after} mark="ins" />
          </p>
        </div>
      </div>
      <div className="w3-co-cmp__acts">
        <button type="button" className="w3-st-ghost w3-st-ghost--sm" onClick={onKeep}>
          Keep the card's
        </button>
        <button type="button" className="w3-st-pill w3-co-pill" onClick={onUse}>
          Use the new one
        </button>
      </div>
    </div>
  );
}

/** A written field: read at full size, edit in place, or empty it. */
function Section({
  label,
  text,
  tokens,
  lit,
  onEdit,
  onClear,
  children,
  disabled = false,
}: {
  label: string;
  text: string;
  tokens?: number;
  lit: boolean;
  onEdit?: (text: string) => void;
  onClear?: () => void;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [armed, setArmed] = useState(false);
  const long = text.length > 700;
  const save = () => {
    if (draft !== text) onEdit?.(draft);
    setEditing(false);
  };
  return (
    <section className="w3-co-sec" data-lit={lit || undefined}>
      <h4>
        {label}
        {tokens !== undefined ? <span>{tokens.toLocaleString()} tokens</span> : <span />}
        {onEdit && !editing ? (
          <button
            type="button"
            aria-label={`Edit ${label}`}
            disabled={disabled}
            onClick={() => {
              setDraft(text);
              setEditing(true);
            }}
          >
            <Icon name="pencil" size="xs" />
          </button>
        ) : null}
        {onClear ? (
          <button
            type="button"
            data-armed={armed || undefined}
            aria-label={armed ? `Click again to empty ${label}` : `Empty ${label}`}
            title={armed ? 'Click again to empty it' : 'Empty it'}
            onClick={() => (armed ? onClear() : setArmed(true))}
            onBlur={() => setArmed(false)}
          >
            <Icon name="close" size="xs" />
          </button>
        ) : null}
      </h4>
      {children}
      {editing ? (
        <textarea
          className="w3-co-sec__edit"
          value={draft}
          aria-label={label}
          // biome-ignore lint/a11y/noAutofocus: opened by its pencil on purpose
          autoFocus
          rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false);
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
          }}
        />
      ) : (
        <>
          <div className="w3-co-sec__text" data-open={open || !long || undefined}>
            {text}
          </div>
          {long ? (
            <button type="button" className="w3-co-sec__more" onClick={() => setOpen(!open)}>
              {open ? 'Less' : 'Read it all'}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

export function CoCreatorCard({
  stash,
  title,
  seedName,
  canUpdate,
  hasTarget,
  draftBlock,
  baseline,
  finishReview,
  finishChoices,
  onFinishChoice,
  pendingFinish,
  sessionId,
  avatar,
  cacheKey,
  countTokens,
  pending,
  lit,
  busy,
  finishing,
  edits,
  onKeep,
  onAccept,
  onAsk,
  onAvatar,
  onError,
  onFinish,
}: {
  stash: CardStash;
  title: string;
  /** The card this session writes back to, or null for a new card. */
  seedName: string | null;
  canUpdate: boolean;
  hasTarget: boolean;
  draftBlock: string;
  baseline: CocreatorCardBaseline | null;
  finishReview: FinishConflictError | null;
  finishChoices: DraftChoices;
  onFinishChoice: (field: DraftField | 'portrait', choice: 'library' | 'draft') => void;
  pendingFinish: boolean;
  sessionId: string;
  avatar: string | null;
  cacheKey: number;
  countTokens: TokenCounter;
  pending: Pending | null;
  /** The field that just changed, lit for a moment. */
  lit: CardSlot | null;
  busy: boolean;
  finishing: boolean;
  edits: CardEdits;
  onKeep: () => void;
  onAccept: () => void;
  /** Ask the Co-Creator to write an empty field. */
  onAsk: (label: string) => void;
  onAvatar: (avatar: string | null) => void;
  onError: (message: string) => void;
  onFinish: (mode: 'update' | 'create') => void;
}) {
  const [greet, setGreet] = useState(0);
  const [over, setOver] = useState(false);
  const [working, setWorking] = useState(false);
  const [armedArt, setArmedArt] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const tokens = (text: string | undefined) => (text?.trim() ? countTokens.countText(text) : 0);
  const always = ALWAYS.reduce((total, slot) => total + tokens(stash[slot]?.text), 0);
  const fields = cardFields(stash);
  const name = stash.name?.text.trim() || title || 'Untitled';
  const greetings = [
    ...(stash.first_mes?.text ? [{ text: stash.first_mes.text, first: true }] : []),
    ...stash.alternate_greetings.map((entry) => ({ text: entry.text, first: false })),
  ];
  const shownGreet = Math.min(greet, Math.max(0, greetings.length - 1));
  const altIndex = shownGreet - (stash.first_mes?.text ? 1 : 0);

  const accept = async (file: File | undefined) => {
    if (!file || busy || working) return;
    setWorking(true);
    try {
      const saved = await cocreatorApi.setAvatar(sessionId, await cropToCardRatio(file));
      onAvatar(saved.avatar);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const clearArt = async () => {
    setArmedArt(false);
    setWorking(true);
    try {
      await cocreatorApi.clearAvatar(sessionId);
      onAvatar(null);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const single = (slot: SingleCardSlot) => {
    const entry = stash[slot];
    if (!entry?.text) return null;
    return (
      <Section
        disabled={busy}
        key={slot}
        label={SLOT_LABELS[slot]}
        text={entry.text}
        tokens={slot === 'creator_notes' ? undefined : tokens(entry.text)}
        lit={lit === slot}
        onEdit={(text) => edits.editSlot(slot, text)}
        onClear={() => edits.clearSlot(slot)}
      />
    );
  };

  const empty = fields.filter((field) => !field.filled && field.slot !== 'name');

  return (
    <section className="w3-co-card" aria-label="The card so far">
      <div className="w3-co-card__sheet">
        {finishReview && !pendingFinish ? (
          <div className="w3-co-save-review">
            <p>
              The character changed in the library. Choose which version to keep for each
              conflicting field, then update.
            </p>
            {finishReview.conflicts.map((conflict) => (
              <div className="w3-co-cmp" key={conflict.field}>
                <b>
                  {conflict.field === 'alternate_greetings'
                    ? 'Alternate greetings'
                    : SLOT_LABELS[conflict.field]}
                </b>
                <div className="w3-co-cmp__two">
                  {(['library', 'draft'] as const).map((side) => (
                    <div className="w3-co-cmp__side" key={side}>
                      <small>{side === 'library' ? 'In the library' : 'Your draft'}</small>
                      <p>{readableValue(conflict[side])}</p>
                      <button
                        type="button"
                        className="w3-st-ghost w3-st-ghost--sm"
                        aria-pressed={finishChoices[conflict.field] === side}
                        onClick={() => onFinishChoice(conflict.field, side)}
                      >
                        {finishChoices[conflict.field] === side ? 'Selected' : 'Keep this version'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {finishReview.portrait ? (
              <div className="w3-co-cmp">
                <b>Portrait</b>
                <div className="w3-co-cmp__two">
                  {(['library', 'draft'] as const).map((side) => (
                    <div className="w3-co-cmp__side" key={side}>
                      <small>{side === 'library' ? 'In the library' : 'Your draft'}</small>
                      {side === 'draft' && !avatar ? (
                        <p>No portrait</p>
                      ) : (
                        <img
                          className="w3-co-save-review__portrait"
                          src={
                            side === 'library'
                              ? characterApi.imageUrl(
                                  finishReview.latest.detail.avatar,
                                  finishReview.latest.detail.modified,
                                )
                              : cocreatorApi.avatarUrl(sessionId, cacheKey)
                          }
                          alt={side === 'library' ? 'Library portrait' : 'Draft portrait'}
                        />
                      )}
                      <button
                        type="button"
                        className="w3-st-ghost w3-st-ghost--sm"
                        aria-pressed={finishChoices.portrait === side}
                        onClick={() => onFinishChoice('portrait', side)}
                      >
                        {finishChoices.portrait === side ? 'Selected' : 'Keep this version'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {pending && !busy ? (
          <Compare
            pending={pending}
            kept={
              pending.greetingId
                ? ([stash.first_mes, ...stash.alternate_greetings].find(
                    (e) => e?.id === pending.greetingId,
                  )?.text ?? '')
                : (stash[pending.slot as SingleCardSlot]?.text ?? '')
            }
            onKeep={onKeep}
            onUse={onAccept}
          />
        ) : null}
        <div className="w3-co-card__top">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping an image is a shortcut; the button is the accessible way */}
          <div
            className="w3-co-art"
            data-over={over || undefined}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              void accept(event.dataTransfer.files[0]);
            }}
          >
            <button
              type="button"
              className="w3-co-art__pick"
              disabled={busy || working}
              title={avatar ? 'Replace the portrait' : 'Drop an image, or click to choose one'}
              onClick={() => fileRef.current?.click()}
            >
              {avatar ? (
                <img src={cocreatorApi.avatarUrl(sessionId, cacheKey)} alt="" draggable={false} />
              ) : (
                <span>
                  <Icon name="upload" size="sm" />
                  {working ? 'Saving…' : 'Drop a portrait'}
                </span>
              )}
            </button>
            {avatar ? (
              <button
                type="button"
                className="w3-co-art__clear"
                data-armed={armedArt || undefined}
                aria-label={armedArt ? 'Click again to remove the portrait' : 'Remove the portrait'}
                onClick={() => (armedArt ? void clearArt() : setArmedArt(true))}
                onBlur={() => setArmedArt(false)}
              >
                <Icon name="close" size="xs" />
              </button>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                void accept(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
          <div className="w3-co-card__name">
            <h2 data-lit={lit === 'name' || undefined}>{name}</h2>
            <small>
              {seedName
                ? `Writing back to ${seedName}`
                : hasTarget
                  ? 'Target no longer in the library'
                  : 'A new card'}{' '}
              · <b>{always.toLocaleString()}</b> tokens always sent
            </small>
          </div>
        </div>

        <div className="w3-co-live" inert={busy}>
          {single('description')}
          {single('personality')}
          {single('scenario')}
          {greetings.length ? (
            <Section
              label="Greetings"
              text={greetings[shownGreet]?.text ?? ''}
              tokens={tokens(greetings[shownGreet]?.text)}
              lit={lit === 'first_mes' || lit === 'alternate_greeting'}
              onEdit={(text) =>
                greetings[shownGreet]?.first
                  ? edits.editSlot('first_mes', text)
                  : edits.editGreeting(altIndex, text)
              }
              onClear={() =>
                greetings[shownGreet]?.first
                  ? edits.clearSlot('first_mes')
                  : edits.removeGreeting(altIndex)
              }
            >
              <div className="w3-co-greets">
                {greetings.map((entry, index) => (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: greetings are positional
                    key={index}
                    type="button"
                    aria-pressed={index === shownGreet}
                    onClick={() => setGreet(index)}
                  >
                    {entry.first ? 'First' : index + 1}
                  </button>
                ))}
                {!greetings[shownGreet]?.first && altIndex > 0 ? (
                  <button
                    type="button"
                    className="w3-co-greets__move"
                    title="Move it earlier"
                    aria-label="Move this greeting earlier"
                    onClick={() => {
                      edits.moveGreeting(altIndex, altIndex - 1);
                      setGreet(shownGreet - 1);
                    }}
                  >
                    <Icon name="chevronLeft" size="xs" />
                  </button>
                ) : null}
              </div>
            </Section>
          ) : null}
          {single('mes_example')}
          {single('system_prompt')}
          {single('post_history_instructions')}
          {stash.tags.length ? (
            <section className="w3-co-sec" data-lit={lit === 'tags' || undefined}>
              <h4>
                Tags
                <span />
              </h4>
              <div className="w3-co-tags">
                {stash.tags.map((tag, index) => (
                  <span key={tag.id}>
                    {tag.text}
                    <button
                      type="button"
                      aria-label={`Remove ${tag.text}`}
                      onClick={() => edits.removeTag(index)}
                    >
                      <Icon name="close" size="xs" />
                    </button>
                  </span>
                ))}
              </div>
            </section>
          ) : null}
          {single('creator_notes')}
          {empty.length ? (
            <div className="w3-co-folds">
              <small>Not written yet</small>
              {empty.map((field) => (
                <button
                  key={field.slot}
                  type="button"
                  className="w3-st-fold"
                  title={`Ask the Co-Creator for the ${field.label.toLowerCase()}`}
                  onClick={() => onAsk(field.label)}
                >
                  <Icon name="plus" size="xs" />
                  {field.label}
                </button>
              ))}
            </div>
          ) : null}
          <details className="w3-co-carried">
            <summary>
              Current card shared with the assistant ·{' '}
              {countTokens.countText(draftBlock).toLocaleString()} tokens
            </summary>
            <pre>{draftBlock}</pre>
          </details>
          {baseline ? (
            <details className="w3-co-carried">
              <summary>Carried lore and metadata · read only</summary>
              <pre>
                {JSON.stringify(
                  {
                    ...Object.fromEntries(
                      Object.entries(baseline.card).filter(
                        ([key]) =>
                          key !== 'data' &&
                          !SINGLE_SLOTS.includes(key as SingleCardSlot) &&
                          key !== 'tags',
                      ),
                    ),
                    data: Object.fromEntries(
                      Object.entries(baseline.card.data).filter(
                        ([key]) =>
                          !SINGLE_SLOTS.includes(key as SingleCardSlot) &&
                          key !== 'tags' &&
                          key !== 'alternate_greetings',
                      ),
                    ),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
      <footer className="w3-co-card__foot">
        <span className="w3-co-card__foot-count">
          {filledCount(stash)} of {MAIN_FIELD_COUNT} fields
        </span>
        {hasTarget && !pendingFinish ? (
          <button
            type="button"
            className="w3-st-ghost w3-st-ghost--sm"
            disabled={busy || working}
            onClick={() => onFinish('create')}
          >
            Create a new character
          </button>
        ) : null}
        <button
          type="button"
          className="w3-st-pill w3-co-finish"
          disabled={
            finishing ||
            working ||
            (busy && !pendingFinish) ||
            (!pendingFinish &&
              hasTarget &&
              (!canUpdate ||
                Boolean(
                  finishReview &&
                    (finishReview.conflicts.some((c) => !finishChoices[c.field]) ||
                      (finishReview.portrait && !finishChoices.portrait)),
                )))
          }
          title={
            !pendingFinish && hasTarget && !canUpdate
              ? 'The target character is no longer in the library. You can create a new character.'
              : undefined
          }
          onClick={() => onFinish(hasTarget ? 'update' : 'create')}
        >
          <Icon name="check" size="sm" />
          {finishing
            ? 'Finishing…'
            : pendingFinish
              ? 'Retry finishing'
              : hasTarget
                ? 'Update character'
                : 'Create a new character'}
        </button>
      </footer>
    </section>
  );
}
