import type { CharacterDetail } from '@shared/types/card.ts';
import type { DialogueColorOverride } from '@shared/types/settings.ts';
import { CHARACTER_RATING_MAX, CHARACTER_RATING_MIN } from '@shared/types/settings.ts';
import type { WorldInfoEntry } from '@shared/types/worldinfo.ts';
import { bookEntries as bookEntriesOf, toWorldInfoBook } from '@shared/worldinfo/convert.ts';
import { useMemo, useRef, useState } from 'react';
import { DialogueColorField } from '../../components/DialogueColorField.tsx';
import { ListField, TagField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { DownloadIcon, StarIcon, TrashIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { useAvatarColor } from '../chat/avatarColor.ts';
import { useCardDraft } from '../studio/useCardDraft.ts';
import { EmbeddedBook } from './EmbeddedBook.tsx';
import './CharacterEditor.css';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function isPngFile(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, PNG_SIGNATURE.length).arrayBuffer());
  return head.length === PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => head[i] === byte);
}

interface CharacterEditorProps {
  detail: CharacterDetail;
  onSaved: (detail: CharacterDetail) => void;
  /** A rename moves the file identity; the app must re-select the character under it. */
  onRenamed: (detail: CharacterDetail) => void;
  onDeleted: () => void;
  onBack: () => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
  dialogueColor: DialogueColorOverride | undefined;
  dialogueColorsEnabled: boolean;
  /** The user's rating for this character, or undefined when unrated. */
  rating: number | undefined;
  onRatingChange: (value: number | undefined) => void;
  avatarVersion?: number;
  onDialogueColorChange: (value: DialogueColorOverride | undefined) => void;
  onAvatarChanged: () => void;
}

export function CharacterEditor({
  detail,
  onSaved,
  onRenamed,
  onDeleted,
  onBack,
  registerPersistence,
  dialogueColor,
  dialogueColorsEnabled,
  rating,
  onRatingChange,
  avatarVersion,
  onDialogueColorChange,
  onAvatarChanged,
}: CharacterEditorProps) {
  const draft = useCardDraft({
    detail,
    onSaved,
    onRenamed,
    onDeleted,
    registerPersistence,
  });
  const { data, avatar } = draft;
  const [nameDraft, setNameDraft] = useState(detail.card.data.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const avatarUrl = characterApi.imageUrl(avatar, avatarVersion);
  const autoDialogueColor = useAvatarColor(dialogueColor === undefined ? avatarUrl : null);

  async function handleImageChange(file: File | undefined) {
    if (!file) return;
    if (!(await isPngFile(file))) {
      draft.reportError('Character cards must be PNG images so the card data can be embedded.');
      return;
    }
    try {
      await draft.replaceAvatar(file);
      onAvatarChanged();
    } catch {}
  }

  /**
   * Rename the character's file identity, not just its display name.
   *
   * The PNG filename is what the chats key on, so this goes through the rename endpoint —
   * which moves the file and carries the transcripts over — rather than the field autosave,
   * which would only touch the card's `name` and leave the identity (and the chats) behind.
   * Committed on blur/Enter rather than per keystroke for the same reason the lore rename
   * does: a rename is a file move, and saving per keystroke would leave a trail of files.
   */
  async function handleRename() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === data.name) {
      setNameDraft(data.name);
      return;
    }
    await draft.rename(trimmed);
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await draft.remove();
  }

  async function handleBack() {
    try {
      await draft.flush();
      onBack();
    } catch (err) {
      draft.reportError((err as Error).message);
    }
  }

  async function retrySaves() {
    try {
      await draft.retry();
    } catch {}
  }

  const lorebookEntries = data.character_book?.entries ?? [];

  // Normalised for the shared editor. The engine consumes this shape too, so converting
  // here means one conversion boundary rather than one per screen.
  const bookEntries = useMemo(
    () =>
      data.character_book
        ? bookEntriesOf(toWorldInfoBook(data.character_book))
        : ([] as WorldInfoEntry[]),
    [data.character_book],
  );

  const statusLabel = useMemo(() => {
    switch (draft.saveState) {
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'error':
        return draft.saveError ?? 'Save failed';
      default:
        return '';
    }
  }, [draft.saveError, draft.saveState]);

  return (
    <div className="editor">
      <div className="editor__top">
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={() => void handleBack()}
        >
          ← All characters
        </button>
        <span className="editor__status" data-state={draft.saveState}>
          {statusLabel}
        </span>
        {draft.saveState === 'error' ? (
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => void retrySaves()}
          >
            Retry save
          </button>
        ) : null}
      </div>

      <div className="editor__identity">
        <button
          type="button"
          className="editor__avatar-button"
          onClick={() => imageInput.current?.click()}
          title="Replace avatar image"
        >
          <img className="editor__avatar" src={avatarUrl} alt="" />
          <span className="editor__avatar-overlay">Replace</span>
        </button>
        <input
          ref={imageInput}
          type="file"
          accept="image/png"
          className="wc-visually-hidden"
          onChange={(e) => {
            handleImageChange(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        <div className="editor__identity-fields">
          <TextField
            label="Name"
            value={nameDraft}
            onChange={setNameDraft}
            onCommit={() => void handleRename()}
            hint="Renaming moves the character's file; existing chats follow it."
          />
          <div className="editor__row">
            <TextField
              label="Creator"
              value={data.creator}
              onChange={(v) => draft.update('creator', v)}
            />
            <TextField
              label="Version"
              value={data.character_version}
              onChange={(v) => draft.update('character_version', v)}
            />
          </div>
          <RatingField
            value={rating}
            onChange={onRatingChange}
            hint="Your own rating — stored in the app's settings, never written into the card."
          />
        </div>
      </div>

      <Section title="Appearance">
        <DialogueColorField
          value={dialogueColor}
          autoColor={autoDialogueColor}
          globallyEnabled={dialogueColorsEnabled}
          onChange={onDialogueColorChange}
        />
      </Section>

      <Section title="Description" defaultOpen badge={`${data.description.length}`}>
        <TextField
          label="Description"
          value={data.description}
          onChange={(v) => draft.update('description', v)}
          multiline
          expandable
          rows={10}
          hint="The character's core definition. Always sent, via the charDescription prompt."
        />
        <TextField
          label="Personality"
          value={data.personality}
          onChange={(v) => draft.update('personality', v)}
          multiline
          expandable
          rows={3}
        />
        <TextField
          label="Scenario"
          value={data.scenario}
          onChange={(v) => draft.update('scenario', v)}
          multiline
          expandable
          rows={3}
        />
      </Section>

      <Section title="Greetings" badge={`${1 + data.alternate_greetings.length}`}>
        <TextField
          label="First message"
          value={data.first_mes}
          onChange={(v) => draft.update('first_mes', v)}
          multiline
          expandable
          rows={8}
          hint="Opens every new chat. Supports {{char}} and {{user}}."
        />
        <ListField
          label="Alternate greetings"
          value={data.alternate_greetings}
          onChange={(v) => draft.update('alternate_greetings', v)}
          addLabel="Add greeting"
          hint="Available as swipes on the opening message."
        />
      </Section>

      <Section title="Example dialogue">
        <TextField
          label="Examples"
          value={data.mes_example}
          onChange={(v) => draft.update('mes_example', v)}
          multiline
          expandable
          rows={10}
          hint="Separate blocks with <START>. Use {{user}}: and {{char}}: prefixes."
        />
      </Section>

      <Section title="Prompt overrides">
        <TextField
          label="System prompt"
          value={data.system_prompt}
          onChange={(v) => draft.update('system_prompt', v)}
          multiline
          expandable
          rows={5}
          hint="Replaces the preset's Main Prompt unless that prompt forbids overrides."
        />
        <TextField
          label="Post-history instructions"
          value={data.post_history_instructions}
          onChange={(v) => draft.update('post_history_instructions', v)}
          multiline
          expandable
          rows={5}
          hint="Replaces the preset's Post-History Instructions (jailbreak) prompt."
        />
      </Section>

      <Section
        title="Lorebook"
        badge={lorebookEntries.length ? `${lorebookEntries.length}` : 'none'}
      >
        {/*
          Edited through its own endpoints, not the autosave above — each one mutates a
          single entry on the stored card. The autosave's field list deliberately omits
          character_book: mergeCardData replaces it wholesale, so sending a client-built
          book would let a stale tab write a mass deletion into the PNG.
        */}
        <EmbeddedBook
          avatar={avatar}
          entries={bookEntries}
          onSaved={draft.handleBookSaved}
          onError={draft.reportError}
          serializeCardWrite={draft.serializeCardWrite}
          registerPersistence={draft.registerBookPersistence}
        />
      </Section>

      <Section title="Metadata">
        <TagField label="Tags" value={data.tags} onChange={(v) => draft.update('tags', v)} />
        <TextField
          label="Creator notes"
          value={data.creator_notes}
          onChange={(v) => draft.update('creator_notes', v)}
          multiline
          expandable
          rows={4}
          hint="Not sent to the model — notes for whoever uses the card."
        />
      </Section>

      <div className="editor__actions">
        <a className="wc-button" href={characterApi.exportUrl(avatar, 'png')} download>
          <DownloadIcon />
          Export PNG
        </a>
        <a className="wc-button" href={characterApi.exportUrl(avatar, 'json')} download>
          <DownloadIcon />
          Export JSON
        </a>
        <button
          type="button"
          className="wc-button wc-button--danger"
          onClick={handleDelete}
          onBlur={() => setConfirmDelete(false)}
        >
          <TrashIcon />
          {confirmDelete ? 'Click again to confirm' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

/**
 * The five-star rating control. Clicking the N-th star rates N; clicking the star already
 * selected clears the rating, because an unrate path is what makes the list's "unrated
 * shows nothing" honest — without it there would be no way back.
 */
function RatingField({
  value,
  onChange,
  hint,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  hint?: string;
}) {
  return (
    <div className="field">
      <div className="field__head">
        <span className="wc-label">My rating</span>
        {value !== undefined ? (
          <span className="field__meta">
            {value} of {CHARACTER_RATING_MAX}
          </span>
        ) : null}
      </div>
      <div className="rating-field">
        {Array.from(
          { length: CHARACTER_RATING_MAX - CHARACTER_RATING_MIN + 1 },
          (_, index) => CHARACTER_RATING_MIN + index,
        ).map((star) => {
          const selected = value !== undefined && star <= value;
          return (
            <button
              key={star}
              type="button"
              aria-pressed={selected}
              aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`}
              className="rating-field__star"
              data-filled={selected || undefined}
              onClick={() => onChange(value === star ? undefined : star)}
            >
              <StarIcon filled={selected} />
            </button>
          );
        })}
      </div>
      {hint ? (
        <p className="wc-hint" id="character-rating-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
