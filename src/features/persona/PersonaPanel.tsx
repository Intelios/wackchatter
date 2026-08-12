/**
 * The "You" tab: who you are in the chat.
 *
 * There is one current persona, and picking a card sets it — with a chat open the same
 * click also switches THIS chat to it (`ChatMetadata.persona`), so the two never drift.
 * Loading an older chat adopts its recorded persona as the current one, which is why the
 * chat's own state still exists: a transcript records who you were when you wrote it.
 */

import type { Persona } from '@shared/types/chat.ts';
import type { DialogueColorOverride, DialogueColorSettings } from '@shared/types/settings.ts';
import type { LorebookSummary } from '@shared/types/worldinfo.ts';
import { useEffect, useRef, useState } from 'react';
import { DialogueColorField } from '../../components/DialogueColorField.tsx';
import { NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { EditIcon, PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { personaApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';
import { useAvatarColor } from '../chat/avatarColor.ts';
import './PersonaPanel.css';

const SAVE_DELAY = 500;

const POSITION_OPTIONS = [
  { label: 'In the prompt (at the marker)', value: 'inPrompt' as const },
  { label: 'Above Author’s Note', value: 'topAuthorNote' as const },
  { label: 'Below Author’s Note', value: 'bottomAuthorNote' as const },
  { label: 'At a depth in the chat', value: 'atDepth' as const },
  { label: 'Nowhere — macro only', value: 'none' as const },
];

const ROLE_OPTIONS = [
  { label: 'System', value: 'system' as const },
  { label: 'User', value: 'user' as const },
  { label: 'Assistant', value: 'assistant' as const },
];

interface PersonaPanelProps {
  personas: Persona[];
  books: LorebookSummary[];
  /** The app-wide current persona. */
  activeId: string | null;
  /** Set the current persona — and the open chat's, when there is one. */
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
  dialogueColors: DialogueColorSettings;
  avatarVersions: Readonly<Record<string, number>>;
  onDialogueColorChange: (id: string, value: DialogueColorOverride | undefined) => void;
  onAvatarChanged: (id: string) => void;
  onDeleted: (id: string) => void;
}

export function PersonaPanel({
  personas,
  books,
  activeId,
  onSelect,
  onChanged,
  registerPersistence,
  dialogueColors,
  avatarVersions,
  onDialogueColorChange,
  onAvatarChanged,
  onDeleted,
}: PersonaPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Persona | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const draftAvatarUrl = draft?.avatar
    ? personaApi.avatarUrl(draft.id, avatarVersions[draft.id] ?? draft.avatar)
    : null;
  const draftDialogueColor = draft ? dialogueColors.personas[draft.id] : undefined;
  const autoDialogueColor = useAvatarColor(
    draft && draftDialogueColor === undefined ? draftAvatarUrl : null,
  );

  /**
   * Edits made since the persona was opened.
   *
   * Accumulated rather than replaced: each keystroke reschedules, so sending only the most
   * recent field would drop every earlier one. Crucially this is reset only when the
   * selection changes — never on a successful save — because the queue clones each scheduled
   * snapshot, and clearing the accumulation mid-flight would let a later edit reschedule a
   * patch missing fields an older, still-pending snapshot had not yet written.
   */
  const queued = useRef<Partial<Persona>>({});

  /** Which persona `draft` currently holds, so a refresh can be told from a selection. */
  const draftId = useRef<string | null>(null);

  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // One queue shared by every persona, keyed per persona so switching selection neither
  // cancels the previous persona's write nor lets a delayed callback observe a reset queue.
  // Writes are serialized and a failure is retained for retry rather than dropped.
  const queueRef = useRef<AutosaveQueue<Partial<Persona>, Persona> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new AutosaveQueue((id, patch) => personaApi.save(id, patch), SAVE_DELAY, {
      onSaved: () => {
        setError(null);
        onChangedRef.current();
      },
      onFailed: (_id, err) => setError(err.message),
    });
  }
  const queue = queueRef.current;

  useEffect(() => {
    registerPersistence?.({
      flush: () => queue.flushAll(),
      retry: () => queue.flushAll(),
    });
    return () => registerPersistence?.(null);
  }, [queue, registerPersistence]);

  useEffect(() => {
    if (!editing) {
      if (draftId.current) void queue.flush(draftId.current).catch(() => {});
      draftId.current = null;
      setDraft(null);
      queued.current = {};
      return;
    }

    // Already loaded. Every later run of this effect is a `personas` refresh — usually
    // the one our own save triggered — and re-syncing then would clobber whatever was
    // typed while the request was in flight.
    if (draftId.current === editing) return;

    // Not in the list yet: creating a persona sets the selection and refreshes the list,
    // and the two need not land in the same render. `personas` stays in the dependency
    // list precisely so this retries when it arrives.
    const found = personas.find((item) => item.id === editing);
    if (!found) return;

    // Leaving a persona: flush it so an edit made just before switching is not lost. The
    // queue owns cloned snapshots, so resetting `queued` afterwards cannot drop them.
    if (draftId.current && draftId.current !== editing) {
      void queue.flush(draftId.current).catch(() => {});
    }

    draftId.current = editing;
    setDraft(found);
    setConfirmDelete(false);
    queued.current = {};
  }, [editing, personas, queue]);

  // Flush every pending write on unmount, or the last edit before closing the panel is lost.
  useEffect(() => {
    return () => {
      void queue.flushAll().catch(() => {});
    };
  }, [queue]);

  function patch(update: Partial<Persona>) {
    if (!draft) return;
    const id = draft.id;
    setDraft({ ...draft, ...update });
    queued.current = { ...queued.current, ...update };
    queue.schedule(id, queue.nextRevision(id), queued.current);
  }

  async function selectEditor(next: string | null): Promise<void> {
    const current = draftId.current;
    if (current && current !== next) {
      try {
        await queue.flush(current);
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    setEditing(next);
  }

  async function handleCreate() {
    try {
      const created = await personaApi.create('You');
      onChanged();
      await selectEditor(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    try {
      await queue.runSerialized(id, () => personaApi.remove(id));
      queue.discard(id);
      setEditing(null);
      // Chats keep the explicit orphaned id and resolve it as no persona. That preserves
      // their snapshot if this persona is restored later.
      if (activeId === id) onSelect(null);
      onDeleted(id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAvatar(id: string, file: File) {
    try {
      const saved = await queue.runSerialized(id, () => personaApi.uploadAvatar(id, file));
      setDraft((current) => (current?.id === id ? { ...current, avatar: saved.avatar } : current));
      onAvatarChanged(id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="persona-panel">
      {error ? (
        <p className="persona-panel__error">
          {error}{' '}
          {editing ? (
            <button
              type="button"
              className="wc-button wc-button--ghost"
              onClick={() => void queue.retry(editing).catch(() => {})}
            >
              Retry save
            </button>
          ) : null}
        </p>
      ) : null}

      {draft ? (
        <div className="persona-editor">
          <div className="persona-editor__top">
            <button
              type="button"
              className="wc-button wc-button--ghost"
              onClick={() => void selectEditor(null)}
            >
              ← All personas
            </button>
          </div>

          <div className="persona-editor__fields">
            <TextField
              label="Name"
              value={draft.name}
              onChange={(name) => patch({ name })}
              hint="What {{user}} expands to, and the label on your messages."
            />

            <TextField
              label="Description"
              value={draft.description}
              onChange={(description) => patch({ description })}
              multiline
              expandable
              rows={6}
              placeholder="Who you are in the story."
              hint="Available as {{persona}} wherever it is positioned."
            />

            <label className="persona-editor__avatar wc-button">
              {draft.avatar ? 'Replace avatar' : 'Upload avatar'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleAvatar(draft.id, file);
                  event.target.value = '';
                }}
              />
            </label>

            <DialogueColorField
              value={draftDialogueColor}
              autoColor={autoDialogueColor}
              globallyEnabled={dialogueColors.enabled}
              onChange={(value) => onDialogueColorChange(draft.id, value)}
            />

            <Section title="Placement">
              <SelectField<'inPrompt' | 'topAuthorNote' | 'bottomAuthorNote' | 'atDepth' | 'none'>
                label="Where the description goes"
                value={draft.position ?? 'inPrompt'}
                options={POSITION_OPTIONS}
                onChange={(position) => patch({ position })}
                hint="{{persona}} keeps working whichever you pick."
              />

              {draft.position === 'atDepth' ? (
                <div className="field-row">
                  <NumberField
                    label="Depth"
                    value={draft.depth ?? 2}
                    min={0}
                    onChange={(depth) => patch({ depth })}
                    hint="Messages back from the end."
                  />
                  <SelectField<'system' | 'user' | 'assistant'>
                    label="Role"
                    value={draft.role ?? 'system'}
                    options={ROLE_OPTIONS}
                    onChange={(role) => patch({ role })}
                  />
                </div>
              ) : null}
            </Section>

            <Section title="Lorebook">
              <SelectField<string>
                label="Persona lorebook"
                value={draft.lorebookId ?? ''}
                options={[
                  { label: 'None', value: '' },
                  ...books.map((book) => ({ label: book.name, value: book.id })),
                ]}
                onChange={(lorebookId) => patch({ lorebookId: lorebookId || null })}
                hint="Loaded ahead of character and global lore whenever this persona is active."
              />
              {draft.lorebookId && !books.some((book) => book.id === draft.lorebookId) ? (
                <p className="wc-hint persona-panel__warning">
                  Missing lorebook “{draft.lorebookId}”. Generation will continue without it.
                </p>
              ) : null}
            </Section>

            <div className="persona-editor__footer">
              <button
                type="button"
                className="wc-button wc-button--ghost wc-button--danger"
                onClick={() =>
                  confirmDelete ? void handleDelete(draft.id) : setConfirmDelete(true)
                }
                onBlur={() => setConfirmDelete(false)}
              >
                <TrashIcon />
                {confirmDelete ? 'Click again to delete' : 'Delete persona'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {personas.length === 0 ? (
            <div className="wc-empty">
              <span>No personas yet.</span>
              <span>Create one to say who you are in the chat.</span>
            </div>
          ) : (
            <ul className="persona-grid">
              {personas.map((persona) => (
                <li
                  key={persona.id}
                  className="persona-card"
                  data-active={activeId === persona.id || undefined}
                >
                  {/* A container rather than one big button: the card needs two distinct
                      actions, and a button inside a button is invalid. */}
                  <button
                    type="button"
                    className="persona-card__pick"
                    onClick={() => onSelect(persona.id)}
                    title="Use this persona"
                  >
                    <span className="persona-card__image">
                      {persona.avatar ? (
                        <img
                          src={personaApi.avatarUrl(
                            persona.id,
                            avatarVersions[persona.id] ?? persona.avatar,
                          )}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span className="persona-card__initial" aria-hidden="true">
                          {persona.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <span className="persona-card__name">{persona.name}</span>
                  </button>

                  <button
                    type="button"
                    className="persona-card__edit"
                    onClick={() => void selectEditor(persona.id)}
                    title={`Edit ${persona.name}`}
                    aria-label={`Edit ${persona.name}`}
                  >
                    <EditIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="persona-panel__footer">
            <button type="button" className="wc-button" onClick={() => void handleCreate()}>
              <PlusIcon />
              New persona
            </button>
            {activeId ? (
              <button
                type="button"
                className="wc-button wc-button--ghost"
                onClick={() => onSelect(null)}
              >
                Use none
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
