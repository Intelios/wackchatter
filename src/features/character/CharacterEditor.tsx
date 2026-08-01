import type { CardDataV2, CharacterDetail } from '@shared/types/card.ts';
import type { WorldInfoEntry } from '@shared/types/worldinfo.ts';
import { bookEntries as bookEntriesOf, toWorldInfoBook } from '@shared/worldinfo/convert.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListField, TagField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { DownloadIcon, TrashIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { EmbeddedBook } from './EmbeddedBook.tsx';
import './CharacterEditor.css';

const AUTOSAVE_DELAY_MS = 700;

interface CharacterEditorProps {
  detail: CharacterDetail;
  onSaved: (detail: CharacterDetail) => void;
  onDeleted: () => void;
  onBack: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function CharacterEditor({ detail, onSaved, onDeleted, onBack }: CharacterEditorProps) {
  const [data, setData] = useState<CardDataV2>(detail.card.data);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);

  const avatar = detail.avatar;
  /** Set while a save is in flight so its response doesn't clobber newer local edits. */
  const dirtyRef = useRef(false);

  // Reset local state when a different character is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on avatar by design
  useEffect(() => {
    setData(detail.card.data);
    dirtyRef.current = false;
    setSaveState('idle');
    setSaveError(null);
    setConfirmDelete(false);
  }, [avatar]);

  const update = useCallback(<K extends keyof CardDataV2>(key: K, value: CardDataV2[K]) => {
    dirtyRef.current = true;
    setData((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Debounced autosave. Only the fields we manage are sent; the server merges them onto
  // the stored card so unknown keys are never at risk.
  useEffect(() => {
    if (!dirtyRef.current) return;

    const timer = setTimeout(async () => {
      setSaveState('saving');
      try {
        const saved = await characterApi.update(avatar, {
          name: data.name,
          description: data.description,
          personality: data.personality,
          scenario: data.scenario,
          first_mes: data.first_mes,
          mes_example: data.mes_example,
          creator_notes: data.creator_notes,
          system_prompt: data.system_prompt,
          post_history_instructions: data.post_history_instructions,
          alternate_greetings: data.alternate_greetings,
          tags: data.tags,
          creator: data.creator,
          character_version: data.character_version,
        });
        dirtyRef.current = false;
        setSaveState('saved');
        setSaveError(null);
        onSaved(saved);
      } catch (err) {
        setSaveState('error');
        setSaveError((err as Error).message);
      }
    }, AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [data, avatar, onSaved]);

  async function handleImageChange(file: File | undefined) {
    if (!file) return;
    setSaveState('saving');
    try {
      const saved = await characterApi.updateWithImage(avatar, {}, file);
      setSaveState('saved');
      onSaved(saved);
    } catch (err) {
      setSaveState('error');
      setSaveError((err as Error).message);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await characterApi.remove(avatar);
      onDeleted();
    } catch (err) {
      setSaveError((err as Error).message);
    }
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

  // The book endpoints return the whole updated card, so the local copy follows the
  // server's rather than being patched twice from two directions.
  const handleBookSaved = useCallback(
    (saved: CharacterDetail) => {
      setData(saved.card.data);
      onSaved(saved);
    },
    [onSaved],
  );

  const statusLabel = useMemo(() => {
    switch (saveState) {
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'error':
        return saveError ?? 'Save failed';
      default:
        return '';
    }
  }, [saveState, saveError]);

  return (
    <div className="editor">
      <div className="editor__top">
        <button type="button" className="wc-button wc-button--ghost" onClick={onBack}>
          ← All characters
        </button>
        <span className="editor__status" data-state={saveState}>
          {statusLabel}
        </span>
      </div>

      <div className="editor__identity">
        <button
          type="button"
          className="editor__avatar-button"
          onClick={() => imageInput.current?.click()}
          title="Replace avatar image"
        >
          <img
            className="editor__avatar"
            src={characterApi.imageUrl(avatar, detail.modified)}
            alt=""
          />
          <span className="editor__avatar-overlay">Replace</span>
        </button>
        <input
          ref={imageInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="wc-visually-hidden"
          onChange={(e) => {
            handleImageChange(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        <div className="editor__identity-fields">
          <TextField label="Name" value={data.name} onChange={(v) => update('name', v)} />
          <div className="editor__row">
            <TextField
              label="Creator"
              value={data.creator}
              onChange={(v) => update('creator', v)}
            />
            <TextField
              label="Version"
              value={data.character_version}
              onChange={(v) => update('character_version', v)}
            />
          </div>
        </div>
      </div>

      <Section title="Description" defaultOpen badge={`${data.description.length}`}>
        <TextField
          label="Description"
          value={data.description}
          onChange={(v) => update('description', v)}
          multiline
          rows={10}
          hint="The character's core definition. Always sent, via the charDescription prompt."
        />
        <TextField
          label="Personality"
          value={data.personality}
          onChange={(v) => update('personality', v)}
          multiline
          rows={3}
        />
        <TextField
          label="Scenario"
          value={data.scenario}
          onChange={(v) => update('scenario', v)}
          multiline
          rows={3}
        />
      </Section>

      <Section title="Greetings" badge={`${1 + data.alternate_greetings.length}`}>
        <TextField
          label="First message"
          value={data.first_mes}
          onChange={(v) => update('first_mes', v)}
          multiline
          rows={8}
          hint="Opens every new chat. Supports {{char}} and {{user}}."
        />
        <ListField
          label="Alternate greetings"
          value={data.alternate_greetings}
          onChange={(v) => update('alternate_greetings', v)}
          addLabel="Add greeting"
          hint="Available as swipes on the opening message."
        />
      </Section>

      <Section title="Example dialogue">
        <TextField
          label="Examples"
          value={data.mes_example}
          onChange={(v) => update('mes_example', v)}
          multiline
          rows={10}
          hint="Separate blocks with <START>. Use {{user}}: and {{char}}: prefixes."
        />
      </Section>

      <Section title="Prompt overrides">
        <TextField
          label="System prompt"
          value={data.system_prompt}
          onChange={(v) => update('system_prompt', v)}
          multiline
          rows={5}
          hint="Replaces the preset's Main Prompt unless that prompt forbids overrides."
        />
        <TextField
          label="Post-history instructions"
          value={data.post_history_instructions}
          onChange={(v) => update('post_history_instructions', v)}
          multiline
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
          onSaved={handleBookSaved}
          onError={setSaveError}
        />
      </Section>

      <Section title="Metadata">
        <TagField label="Tags" value={data.tags} onChange={(v) => update('tags', v)} />
        <TextField
          label="Creator notes"
          value={data.creator_notes}
          onChange={(v) => update('creator_notes', v)}
          multiline
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
