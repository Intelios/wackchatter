import type { CardDataV2, CharacterDetail } from '@shared/types/card.ts';
import type { WorldInfoEntry } from '@shared/types/worldinfo.ts';
import { bookEntries as bookEntriesOf, toWorldInfoBook } from '@shared/worldinfo/convert.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListField, TagField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { DownloadIcon, TrashIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';
import { EmbeddedBook } from './EmbeddedBook.tsx';
import './CharacterEditor.css';

const AUTOSAVE_DELAY_MS = 700;

/** Only the fields we manage; the server merges them onto the stored card. */
function toPatch(data: CardDataV2): Partial<CardDataV2> {
  return {
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
  };
}

interface CharacterEditorProps {
  detail: CharacterDetail;
  onSaved: (detail: CharacterDetail) => void;
  /** A rename moves the file identity; the app must re-select the character under it. */
  onRenamed: (detail: CharacterDetail) => void;
  onDeleted: () => void;
  onBack: () => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function CharacterEditor({
  detail,
  onSaved,
  onRenamed,
  onDeleted,
  onBack,
  registerPersistence,
}: CharacterEditorProps) {
  const [data, setData] = useState<CardDataV2>(detail.card.data);
  const [nameDraft, setNameDraft] = useState(detail.card.data.name);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const dataRef = useRef(data);
  const bookPersistenceRef = useRef<PersistenceControls | null>(null);

  const avatar = detail.avatar;
  /** Set while a save is in flight so its response doesn't clobber newer local edits. */
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);

  // Stable refs so the long-lived queue's callbacks always read fresh values rather than
  // the props captured when the queue was constructed.
  const avatarRef = useRef(avatar);
  avatarRef.current = avatar;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // One serialized, revision-aware queue. Writes never overlap, so a slow older response
  // cannot land after a newer one; the pending snapshot is flushed on unmount so an edit
  // made moments before leaving is not lost to the debounce.
  const queueRef = useRef<AutosaveQueue<Partial<CardDataV2>, CharacterDetail> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new AutosaveQueue(
      (id, patch) => characterApi.update(id, patch),
      AUTOSAVE_DELAY_MS,
      {
        onSaved: (id, _patch, saved) => {
          if (id !== avatarRef.current) return;
          dirtyRef.current = false;
          setSaveState('saved');
          setSaveError(null);
          onSavedRef.current(saved);
        },
        onFailed: (id, error) => {
          if (id !== avatarRef.current) return;
          setSaveState('error');
          setSaveError(error.message);
        },
      },
    );
  }
  const queue = queueRef.current;

  // Reset local state when a different character is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on avatar by design
  useEffect(() => {
    setData(detail.card.data);
    dataRef.current = detail.card.data;
    setNameDraft(detail.card.data.name);
    dirtyRef.current = false;
    setSaveState('idle');
    setSaveError(null);
    setConfirmDelete(false);
  }, [avatar]);

  // Flush any pending write on unmount, or the last edit before closing the editor is lost.
  useEffect(() => {
    return () => {
      void queue.flushAll().catch(() => {});
    };
  }, [queue]);

  const update = useCallback(<K extends keyof CardDataV2>(key: K, value: CardDataV2[K]) => {
    dirtyRef.current = true;
    setData((prev) => {
      const next = { ...prev, [key]: value };
      dataRef.current = next;
      return next;
    });
  }, []);

  // Debounced autosave. The queue owns an immutable copy of the patch, so later edits
  // cannot mutate a save that is already queued.
  useEffect(() => {
    if (!dirtyRef.current) return;
    revisionRef.current += 1;
    setSaveState('saving');
    queue.schedule(avatar, revisionRef.current, toPatch(data));
  }, [data, avatar, queue]);

  async function handleImageChange(file: File | undefined) {
    if (!file) return;
    setSaveState('saving');
    try {
      const saved = await queue.runSerialized(avatar, () =>
        characterApi.updateWithImage(avatar, {}, file),
      );
      setSaveState('saved');
      onSaved(saved);
    } catch (err) {
      setSaveState('error');
      setSaveError((err as Error).message);
    }
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
    setSaveState('saving');
    try {
      // Land any pending field edits on the current file before it moves, or they would
      // post to a filename that no longer exists.
      await queue.flush(avatar);
      await bookPersistenceRef.current?.flush();
      const saved = await queue.runSerialized(avatar, () => characterApi.rename(avatar, trimmed));
      queue.discard(avatar);
      setSaveState('saved');
      setSaveError(null);
      onRenamed(saved);
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
      await bookPersistenceRef.current?.flush();
      await queue.runSerialized(avatar, () => characterApi.remove(avatar));
      queue.discard(avatar);
      onDeleted();
    } catch (err) {
      setSaveState('error');
      setSaveError((err as Error).message);
    }
  }

  async function handleBack() {
    try {
      await flushEditor();
      onBack();
    } catch (err) {
      setSaveState('error');
      setSaveError((err as Error).message);
    }
  }

  async function retrySaves() {
    setSaveState('saving');
    try {
      await retryEditor();
      setSaveState('saved');
      setSaveError(null);
    } catch (err) {
      setSaveState('error');
      setSaveError((err as Error).message);
    }
  }

  const flushEditor = useCallback(async () => {
    await queue.flush(avatar);
    await bookPersistenceRef.current?.flush();
  }, [avatar, queue]);

  const retryEditor = useCallback(async () => {
    await queue.retry(avatar);
    await bookPersistenceRef.current?.retry();
  }, [avatar, queue]);

  useEffect(() => {
    registerPersistence?.({ flush: flushEditor, retry: retryEditor });
    return () => registerPersistence?.(null);
  }, [flushEditor, registerPersistence, retryEditor]);

  const serializeCardWrite = useCallback(
    <T,>(task: () => Promise<T>) => queue.runSerialized(avatar, task),
    [avatar, queue],
  );

  const registerBookPersistence = useCallback((controls: PersistenceControls | null) => {
    bookPersistenceRef.current = controls;
  }, []);

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
      const reconciledData = {
        ...dataRef.current,
        character_book: saved.card.data.character_book,
      };
      dataRef.current = reconciledData;
      setData(reconciledData);
      onSaved({
        ...saved,
        card: { ...saved.card, ...toPatch(reconciledData), data: reconciledData },
      });
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
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={() => void handleBack()}
        >
          ← All characters
        </button>
        <span className="editor__status" data-state={saveState}>
          {statusLabel}
        </span>
        {saveState === 'error' ? (
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
          onError={(message) => {
            setSaveState('error');
            setSaveError(message);
          }}
          serializeCardWrite={serializeCardWrite}
          registerPersistence={registerBookPersistence}
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
