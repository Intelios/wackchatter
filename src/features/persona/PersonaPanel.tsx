/**
 * The "You" tab: who you are in the chat.
 *
 * There is one current persona, and picking a card sets it — with a chat open the same
 * click also switches THIS chat to it (`ChatMetadata.persona`), so the two never drift.
 * Loading an older chat adopts its recorded persona as the current one, which is why the
 * chat's own state still exists: a transcript records who you were when you wrote it.
 */

import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { DialogueColorOverride, DialogueColorSettings } from '@shared/types/settings.ts';
import type { LorebookSummary } from '@shared/types/worldinfo.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DialogueColorField } from '../../components/DialogueColorField.tsx';
import { NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import {
  BookIcon,
  EditIcon,
  GridIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '../../layout/icons.tsx';
import { personaApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';
import { useAvatarColor } from '../chat/avatarColor.ts';
import { matchesPersonaQuery, orderPersonas } from './personaRoster.ts';
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
  /** Most recently switched to, newest first — the roster's default grouping. */
  recentIds: readonly string[];
  /** Rows or faces. Persisted, because it is a way of working rather than a mood. */
  density: 'list' | 'gallery';
  onDensityChange: (density: 'list' | 'gallery') => void;
  /** For the description's token count — a persona rides in every prompt. */
  countTokens: TokenCounter;
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
  recentIds,
  density,
  onDensityChange,
  countTokens,
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
  const [query, setQuery] = useState('');
  /**
   * Set when a persona is created, so the editor can put the caret in the Name field.
   *
   * Every new persona arrives called "You", and three of those under three blank tiles is
   * exactly the case a list is least able to tell apart. Focusing the field makes naming
   * the first thing that happens rather than the thing you meant to come back to.
   */
  const focusNameOnOpen = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
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

  // Naming is the first thing to do with a persona that arrived called "You". Runs only
  // for a create, so opening an existing persona does not steal the caret from the reader.
  useLayoutEffect(() => {
    if (!draft || !focusNameOnOpen.current) return;
    focusNameOnOpen.current = false;
    const field = nameRef.current;
    field?.focus({ preventScroll: true });
    field?.select();
  }, [draft]);

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
      focusNameOnOpen.current = true;
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

  /*
   * A search flattens the grouping, the same way `buildCharacterTree` drops folder rows
   * while filtering: with most of the library hidden, "Recent" and "All personas" become
   * two headings over one short list and stop carrying information.
   */
  /*
   * What a collapsed section is holding, shown on its own header.
   *
   * Both sections default closed, so without this the form is short but silent — you cannot
   * tell a persona injected at depth 4 from one at the prompt marker without opening two
   * disclosures on every persona you look at.
   */
  const placementSummary = draft
    ? (POSITION_OPTIONS.find((option) => option.value === (draft.position ?? 'inPrompt'))?.label ??
      'In the prompt')
    : null;
  const lorebookSummary = draft?.lorebookId
    ? (books.find((book) => book.id === draft.lorebookId)?.name ?? 'Missing book')
    : 'None';
  const descriptionTokens = draft ? countTokens.countText(draft.description) : 0;

  const searching = query.trim().length > 0;
  const matches = personas.filter((persona) => matchesPersonaQuery(persona, query));
  const { recent, rest } = searching
    ? { recent: [] as Persona[], rest: matches }
    : orderPersonas(matches, recentIds);
  const grouped = recent.length > 0 && rest.length > 0;

  function avatarUrlFor(persona: Persona): string | null {
    return persona.avatar
      ? personaApi.avatarUrl(persona.id, avatarVersions[persona.id] ?? persona.avatar)
      : null;
  }

  /** The badges that say what a persona will do to the prompt, without opening it. */
  function marksFor(persona: Persona) {
    const missingBook = Boolean(
      persona.lorebookId && !books.some((book) => book.id === persona.lorebookId),
    );
    return (
      <>
        {persona.id === activeId ? <span className="persona-row__you">You</span> : null}
        {persona.lorebookId ? (
          <span
            className="persona-row__mark"
            data-missing={missingBook || undefined}
            title={
              missingBook
                ? `Linked lorebook “${persona.lorebookId}” is missing.`
                : 'Has a persona lorebook'
            }
          >
            <BookIcon />
          </span>
        ) : null}
        {persona.position === 'atDepth' ? (
          <span className="persona-row__mark" title={`Injected at depth ${persona.depth ?? 2}`}>
            D{persona.depth ?? 2}
          </span>
        ) : null}
      </>
    );
  }

  function renderRow(persona: Persona) {
    return (
      // A container rather than one big button: the row has two distinct actions, and a
      // button inside a button is invalid.
      <div
        key={persona.id}
        className="persona-row"
        data-active={activeId === persona.id || undefined}
      >
        <button
          type="button"
          className="persona-row__pick"
          onClick={() => onSelect(persona.id)}
          title={`Write as ${persona.name}`}
        >
          <span className="persona-row__face">
            {persona.avatar ? (
              <img src={avatarUrlFor(persona) ?? ''} alt="" loading="lazy" />
            ) : (
              <span aria-hidden="true">{persona.name.slice(0, 1).toUpperCase()}</span>
            )}
          </span>
          <span className="persona-row__text">
            <span className="persona-row__name">{persona.name}</span>
            <span className="persona-row__desc">
              {persona.description.trim() || 'No description'}
            </span>
          </span>
          <span className="persona-row__marks">{marksFor(persona)}</span>
        </button>

        <button
          type="button"
          className="persona-row__edit"
          onClick={() => void selectEditor(persona.id)}
          title={`Edit ${persona.name}`}
          aria-label={`Edit ${persona.name}`}
        >
          <EditIcon />
        </button>
      </div>
    );
  }

  function renderCell(persona: Persona) {
    return (
      <div className="persona-cell" data-active={activeId === persona.id || undefined}>
        <button
          type="button"
          className="persona-cell__pick"
          onClick={() => onSelect(persona.id)}
          title={`Write as ${persona.name}`}
        >
          <span className="persona-cell__face">
            {persona.avatar ? (
              <img src={avatarUrlFor(persona) ?? ''} alt="" loading="lazy" />
            ) : (
              <span className="persona-cell__initial" aria-hidden="true">
                {persona.name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
          <span className="persona-cell__name">{persona.name}</span>
        </button>
        <button
          type="button"
          className="persona-cell__edit"
          onClick={() => void selectEditor(persona.id)}
          title={`Edit ${persona.name}`}
          aria-label={`Edit ${persona.name}`}
        >
          <EditIcon />
        </button>
      </div>
    );
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
            <span className="persona-editor__spacer" />
            {/* Up here rather than at the foot of a long scroll — a two-click confirm in
                place, per the no-modals rule. */}
            <button
              type="button"
              className="wc-button wc-button--ghost wc-button--danger"
              onClick={() => (confirmDelete ? void handleDelete(draft.id) : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              title={confirmDelete ? 'Click again to delete' : 'Delete persona'}
            >
              <TrashIcon />
              {confirmDelete ? 'Click again' : null}
            </button>
          </div>

          <div className="persona-editor__fields">
            {/*
             * The face, at a size where a crop decision is judgeable.
             *
             * This URL was computed and thrown away for the editor's whole life — it only
             * ever seeded the dialogue-colour sampler — so replacing an avatar gave you no
             * feedback but a swatch quietly changing hue.
             */}
            <div className="persona-editor__identity">
              <label className="persona-editor__portrait">
                {draftAvatarUrl ? (
                  <img src={draftAvatarUrl} alt="" />
                ) : (
                  <span className="persona-editor__initial" aria-hidden="true">
                    {draft.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="persona-editor__portrait-action">
                  {draft.avatar ? 'Replace' : 'Upload'}
                </span>
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

              <div className="persona-editor__identity-fields">
                <TextField
                  inputRef={nameRef}
                  label="Name"
                  value={draft.name}
                  onChange={(name) => patch({ name })}
                  hint="What {{user}} expands to, and the label on your messages."
                />
                {activeId === draft.id ? (
                  <span className="persona-editor__current">Currently writing as this persona</span>
                ) : (
                  <button
                    type="button"
                    className="wc-button persona-editor__use"
                    onClick={() => onSelect(draft.id)}
                  >
                    Use as me
                  </button>
                )}
              </div>
            </div>

            <TextField
              label="Description"
              value={draft.description}
              onChange={(description) => patch({ description })}
              multiline
              expandable
              rows={6}
              placeholder="Who you are in the story."
              hint="Available as {{persona}} wherever it is positioned."
              // A persona enters every single request, so its cost is worth showing — the
              // same argument the Prompt Manager's per-prompt counts already won.
              meta={`${descriptionTokens} tokens`}
            />

            <DialogueColorField
              value={draftDialogueColor}
              autoColor={autoDialogueColor}
              globallyEnabled={dialogueColors.enabled}
              onChange={(value) => onDialogueColorChange(draft.id, value)}
            />

            <Section title="Placement" badge={placementSummary}>
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

            <Section title="Lorebook" badge={lorebookSummary}>
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
            <>
              <div className="persona-roster__tools">
                <label className="persona-roster__search">
                  <SearchIcon />
                  <input
                    type="search"
                    className="persona-roster__query"
                    value={query}
                    placeholder={`Search ${personas.length} personas…`}
                    aria-label="Search personas"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="wc-button wc-button--ghost persona-roster__density"
                  onClick={() => onDensityChange(density === 'list' ? 'gallery' : 'list')}
                  title={density === 'list' ? 'Show faces' : 'Show rows'}
                  aria-label={density === 'list' ? 'Show faces' : 'Show rows'}
                  aria-pressed={density === 'gallery'}
                >
                  {density === 'list' ? <GridIcon /> : <MenuIcon />}
                </button>
              </div>

              {matches.length === 0 ? (
                <div className="wc-empty">
                  <span>No persona matches “{query.trim()}”.</span>
                </div>
              ) : density === 'gallery' ? (
                <ul className="persona-gallery">
                  {[...recent, ...rest].map((persona) => (
                    <li key={persona.id}>{renderCell(persona)}</li>
                  ))}
                </ul>
              ) : (
                <div className="persona-roster">
                  {/* The headings only earn their place when they separate two groups. With
                      a small library every persona is recent, and "Recent" over the whole
                      list is a label that distinguishes nothing. */}
                  {grouped ? <p className="persona-roster__group">Recent</p> : null}
                  {recent.map(renderRow)}
                  {grouped ? <p className="persona-roster__group">All personas</p> : null}
                  {rest.map(renderRow)}
                </div>
              )}
            </>
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
