/**
 * Everything a lorebook editor does besides drawing: load the open book, autosave its
 * edits, and create, import, rename and delete books.
 *
 * Standalone books are saved whole: unlike a card's embedded book, the file is ours alone
 * and a whole-file write cannot corrupt a character card. Writes are debounced so typing
 * in an entry isn't one request per keystroke. Which book is open is the caller's state.
 */

import type { WorldInfoBook, WorldInfoEntry } from '@shared/types/worldinfo.ts';
import { createWorldInfoEntry } from '@shared/types/worldinfo.ts';
import { bookEntries, nextUid, removeEntry } from '@shared/worldinfo/convert.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lorebookApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';

const SAVE_DELAY = 600;

export interface LorebookWorkbenchOptions {
  /** The open book's id, or null. */
  selected: string | null;
  setSelected: (id: string | null) => void;
  onBooksChanged: () => void;
  /** Bumped whenever a book's contents change, so the engine re-reads it. */
  onBookEdited: (id: string) => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
}

export function useLorebookWorkbench({
  selected,
  setSelected,
  onBooksChanged,
  onBookEdited,
  registerPersistence,
}: LorebookWorkbenchOptions) {
  const [book, setBook] = useState<WorldInfoBook | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stable refs so the long-lived queue's callbacks read the current props.
  const onBookEditedRef = useRef(onBookEdited);
  onBookEditedRef.current = onBookEdited;
  const onBooksChangedRef = useRef(onBooksChanged);
  onBooksChangedRef.current = onBooksChanged;

  // One queue shared by every book, but keyed per book: editing book B schedules under B's
  // id and can no longer cancel a pending write for book A. Writes to one book are
  // serialized; a failed write is retained for retry rather than dropped.
  const queueRef = useRef<AutosaveQueue<WorldInfoBook> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new AutosaveQueue((id, next) => lorebookApi.save(id, next), SAVE_DELAY, {
      onSaved: (id) => {
        setError(null);
        onBookEditedRef.current(id);
        onBooksChangedRef.current();
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
    if (!selected) {
      setBook(null);
      return;
    }
    let cancelled = false;
    lorebookApi
      .get(selected)
      .then((loaded) => {
        if (!cancelled) setBook(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Flush every pending write on unmount, or the last edit before closing the panel is lost.
  useEffect(() => {
    return () => {
      void queue.flushAll().catch(() => {});
    };
  }, [queue]);

  const entries = useMemo(() => (book ? bookEntries(book) : []), [book]);

  const update = useCallback(
    (mutate: (current: WorldInfoBook) => WorldInfoBook) => {
      if (!selected || !book) return;
      const next = mutate(book);
      setBook(next);
      queue.schedule(selected, queue.nextRevision(selected), next);
    },
    [selected, book, queue],
  );

  /** Open another book, or none. Refuses, with the error shown, if the open book's save failed. */
  async function selectBook(next: string | null): Promise<boolean> {
    if (selected && selected !== next) {
      try {
        await queue.flush(selected);
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    }
    setSelected(next);
    return true;
  }

  /** Add an entry at the end of the book; returns its uid. */
  function addEntry(): number | null {
    if (!book) return null;
    const uid = nextUid(book);
    update((current) => {
      const entry = createWorldInfoEntry(uid);
      entry.displayIndex = bookEntries(current).length;
      entry.content = 'New entry.';
      return { ...current, entries: { ...current.entries, [String(uid)]: entry } };
    });
    return uid;
  }

  function updateEntry(uid: number, patch: Partial<WorldInfoEntry>) {
    update((current) => {
      const existing = current.entries[String(uid)];
      if (!existing) return current;
      const next: WorldInfoEntry = { ...existing, ...patch, uid };
      return { ...current, entries: { ...current.entries, [String(uid)]: next } };
    });
  }

  function deleteEntry(uid: number) {
    update((current) => removeEntry(current, uid));
  }

  function reorder(uids: number[]) {
    update((current) => {
      const next = { ...current.entries };
      uids.forEach((uid, index) => {
        const entry = next[String(uid)];
        if (entry) next[String(uid)] = { ...entry, displayIndex: index };
      });
      return { ...current, entries: next };
    });
  }

  async function create() {
    try {
      const created = await lorebookApi.create('New Lorebook');
      onBooksChanged();
      await selectBook(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!selected) return;
    try {
      const id = selected;
      await queue.runSerialized(id, () => lorebookApi.remove(id));
      queue.discard(id);
      setSelected(null);
      onBooksChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function importFile(file: File) {
    try {
      const imported = await lorebookApi.import(file);
      onBooksChanged();
      await selectBook(imported.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rename(name: string) {
    if (!selected) return;
    try {
      const oldId = selected;
      const renamed = await queue.runSerialized(oldId, () => lorebookApi.rename(oldId, name));
      queue.discard(oldId);
      onBooksChanged();
      setSelected(renamed.id);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function retry() {
    if (selected) void queue.retry(selected).catch(() => {});
  }

  return {
    book,
    entries,
    error,
    selectBook,
    addEntry,
    updateEntry,
    deleteEntry,
    reorder,
    create,
    remove,
    importFile,
    rename,
    retry,
  };
}
