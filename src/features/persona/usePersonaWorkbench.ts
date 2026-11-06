/**
 * Everything a persona editor does besides drawing: the draft, autosave, create, variants,
 * the portrait and delete. Shared by the 2.x panel and the 3.0 Personas tool, so the two
 * cannot disagree about how a persona is saved.
 *
 * Which persona is open is the caller's state (`editing`), because the 3.0 shell names the
 * open persona in the margin's heading, outside the tool.
 */

import type { Persona } from '@shared/types/chat.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { personaApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';

const SAVE_DELAY = 500;

export interface PersonaWorkbenchOptions {
  personas: Persona[];
  activeId: string | null;
  /** The persona open in the editor, or null for the list. */
  editing: string | null;
  setEditing: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
  onAvatarChanged: (id: string) => void;
  onDeleted: (id: string) => void;
}

export function usePersonaWorkbench({
  personas,
  activeId,
  editing,
  setEditing,
  onSelect,
  onChanged,
  registerPersistence,
  onAvatarChanged,
  onDeleted,
}: PersonaWorkbenchOptions) {
  const [draft, setDraft] = useState<Persona | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when a persona is created, so the editor can put the caret in the Name field.
   *
   * Every new persona arrives called "You", and three of those under three blank tiles is
   * exactly the case a list is least able to tell apart. Focusing the field makes naming
   * the first thing that happens rather than the thing you meant to come back to.
   */
  const focusNameOnOpen = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  /** Same idea as `focusNameOnOpen`, for a variant: it arrives labelled "Variant", which says nothing. */
  const focusLabelOnOpen = useRef(false);
  const labelRef = useRef<HTMLInputElement>(null);

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

  // Same argument, for a variant: it arrives labelled "Variant", and the label is the one
  // thing that makes a group of same-named rows addressable.
  useLayoutEffect(() => {
    if (!draft || !focusLabelOnOpen.current) return;
    focusLabelOnOpen.current = false;
    const field = labelRef.current;
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

  /** Open a persona in the editor, or go back to the list with null. Refuses if a save failed. */
  async function selectEditor(next: string | null): Promise<boolean> {
    const current = draftId.current;
    if (current && current !== next) {
      try {
        await queue.flush(current);
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    }
    setEditing(next);
    return true;
  }

  async function create() {
    try {
      const created = await personaApi.create('You');
      focusNameOnOpen.current = true;
      onChanged();
      await selectEditor(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** A variant is born a full copy; the editor opening on it is where the flavouring happens. */
  async function addVariant(baseId: string) {
    try {
      const created = await personaApi.createVariant(baseId);
      focusLabelOnOpen.current = true;
      onChanged();
      await selectEditor(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * A converted persona has just been created: refresh the roster and open it in the
   * editor, which is where you would go next anyway to set its placement or a lorebook.
   */
  async function converted(id: string) {
    onChanged();
    await selectEditor(id);
  }

  async function remove(id: string) {
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

  async function uploadAvatar(id: string, file: File) {
    try {
      const saved = await queue.runSerialized(id, () => personaApi.uploadAvatar(id, file));
      setDraft((current) => (current?.id === id ? { ...current, avatar: saved.avatar } : current));
      onAvatarChanged(id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function retry() {
    if (editing) void queue.retry(editing).catch(() => {});
  }

  return {
    draft,
    error,
    nameRef,
    labelRef,
    patch,
    selectEditor,
    create,
    addVariant,
    converted,
    remove,
    uploadAvatar,
    retry,
  };
}
