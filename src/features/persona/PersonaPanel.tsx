/**
 * The "You" tab: who you are in the chat.
 *
 * Two different selections live here and they are not the same thing. The radio picks the
 * persona THIS chat uses (`ChatMetadata.persona`); the "default for new chats" control
 * sets `AppSettings.personaId`. Picking one for the chat also makes it the default, so
 * the common case is one click — but changing the default never reaches back into a chat
 * already in progress, because a transcript records who you were when you wrote it.
 */

import type { Persona } from '@shared/types/chat.ts';
import { useEffect, useRef, useState } from 'react';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { TrashIcon } from '../../layout/icons.tsx';
import { personaApi } from '../../lib/api.ts';
import './PersonaPanel.css';

const SAVE_DELAY = 500;

const POSITION_OPTIONS = [
  { label: 'In the prompt (at the marker)', value: 'inPrompt' as const },
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
  /** The persona the open chat is using. */
  active: Persona | null;
  /** The default for new chats. */
  defaultId: string | null;
  /** True when a chat is open, so the per-chat control has something to act on. */
  hasChat: boolean;
  onSelectForChat: (id: string | null) => void;
  onSelectDefault: (id: string | null) => void;
  onChanged: () => void;
}

export function PersonaPanel({
  personas,
  active,
  defaultId,
  hasChat,
  onSelectForChat,
  onSelectDefault,
  onChanged,
}: PersonaPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Persona | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Edits made since the last write.
   *
   * Accumulated rather than replaced: each keystroke restarts the debounce, so sending
   * only the most recent field would drop every earlier one. Editing the name and then
   * the description within the debounce window used to save the description alone.
   */
  const queued = useRef<Partial<Persona>>({});

  /** Which persona `draft` currently holds, so a refresh can be told from a selection. */
  const draftId = useRef<string | null>(null);

  useEffect(() => {
    if (!editing) {
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

    draftId.current = editing;
    setDraft(found);
    setConfirmDelete(false);
    queued.current = {};
  }, [editing, personas]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function patch(update: Partial<Persona>) {
    if (!draft) return;
    const id = draft.id;
    setDraft({ ...draft, ...update });
    queued.current = { ...queued.current, ...update };

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const body = queued.current;
      queued.current = {};

      personaApi
        .save(id, body)
        .then(() => {
          setError(null);
          onChanged();
        })
        .catch((err) => setError((err as Error).message));
    }, SAVE_DELAY);
  }

  async function handleCreate() {
    try {
      const created = await personaApi.create('You');
      onChanged();
      setEditing(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    try {
      await personaApi.remove(id);
      setEditing(null);
      // Chats that referenced it fall back to the default; nothing to clean up here.
      if (defaultId === id) onSelectDefault(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAvatar(id: string, file: File) {
    try {
      await personaApi.uploadAvatar(id, file);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="persona-panel">
      {error ? <p className="persona-panel__error">{error}</p> : null}

      <ul className="persona-list">
        {personas.map((persona) => (
          <li
            key={persona.id}
            className="persona-list__item"
            data-active={active?.id === persona.id}
          >
            <button
              type="button"
              className="persona-list__pick"
              onClick={() => {
                // Picking for the chat also becomes the default, so the next new chat
                // inherits it without a second click.
                onSelectForChat(persona.id);
                onSelectDefault(persona.id);
              }}
              disabled={!hasChat}
              title={hasChat ? 'Use in this chat' : 'Open a chat first'}
            >
              <span className="persona-list__avatar">
                {persona.avatar ? (
                  <img src={personaApi.avatarUrl(persona.id, persona.avatar)} alt="" />
                ) : (
                  <span aria-hidden="true">{persona.name.slice(0, 1).toUpperCase()}</span>
                )}
              </span>
              <span className="persona-list__name">{persona.name}</span>
              {defaultId === persona.id ? (
                <span className="persona-list__badge">default</span>
              ) : null}
            </button>

            <button
              type="button"
              className="wc-button wc-button--ghost persona-list__edit"
              onClick={() => setEditing(editing === persona.id ? null : persona.id)}
            >
              {editing === persona.id ? 'Close' : 'Edit'}
            </button>
          </li>
        ))}
      </ul>

      <div className="persona-panel__actions">
        <button type="button" className="wc-button" onClick={() => void handleCreate()}>
          New persona
        </button>
        {active ? (
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => onSelectForChat(null)}
            disabled={!hasChat}
          >
            Use none in this chat
          </button>
        ) : null}
      </div>

      {draft ? (
        <div className="persona-editor">
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

          <Section title="Placement">
            <SelectField<'inPrompt' | 'atDepth' | 'none'>
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

          <CheckField
            label="Default for new chats"
            checked={defaultId === draft.id}
            onChange={(on) => onSelectDefault(on ? draft.id : null)}
            hint="Existing chats keep the persona they were started with."
          />

          <div className="persona-editor__footer">
            <button
              type="button"
              className="wc-button wc-button--ghost wc-button--danger"
              onClick={() => (confirmDelete ? void handleDelete(draft.id) : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
            >
              <TrashIcon />
              {confirmDelete ? 'Click again to delete' : 'Delete persona'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
