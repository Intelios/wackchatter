/**
 * The card's embedded lorebook, inside the character editor.
 *
 * Thin: it owns the per-entry requests and nothing else. The editing UI is the same
 * `LorebookEditor` the Lore tab uses, so an entry cannot behave differently depending on
 * which screen it was edited from.
 *
 * Every mutation is one request that names one uid. The server reads the stored PNG,
 * changes that entry and writes it back — no book assembled here ever reaches the card.
 * Because that is a whole-file read/modify/write, two entry saves running at once would
 * race and lose one another's change. All writes for the card therefore go through one
 * serialized queue: field edits are debounced and coalesced per entry, structural ops
 * (add/delete/reorder) run through `runSerialized`, and neither can overlap another.
 */

import type { CharacterDetail } from '@shared/types/card.ts';
import type { WorldInfoEntry } from '@shared/types/worldinfo.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { characterBookApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';
import { LorebookEditor } from '../lore/LorebookEditor.tsx';

/** Field edits are debounced; structural ones (add/delete/reorder) go straight out. */
const SAVE_DELAY = 600;

/** A pending field edit for one entry, with a generation so a save can tell a stale one. */
interface PendingEdit {
  patch: Partial<WorldInfoEntry>;
  gen: number;
}

type PendingMap = Record<number, PendingEdit>;

export interface EmbeddedBookProps {
  avatar: string;
  entries: WorldInfoEntry[];
  onSaved: (detail: CharacterDetail) => void;
  onError: (message: string) => void;
  serializeCardWrite: <T>(task: () => Promise<T>) => Promise<T>;
  registerPersistence?: (controls: PersistenceControls | null) => void;
}

/**
 * The card book's writer: the entries with edits still in flight laid over them, and one
 * function per kind of change.
 */
export function useEmbeddedBook({
  avatar,
  entries,
  onSaved,
  onError,
  serializeCardWrite,
  registerPersistence,
}: EmbeddedBookProps) {
  const [busy, setBusy] = useState(false);
  // Local overlay so typing feels immediate while the debounced write is in flight. The
  // ref is the source of truth; the tick only forces a re-render after it is mutated.
  const pendingRef = useRef<PendingMap>({});
  const [tick, setTick] = useState(0);

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const serializeCardWriteRef = useRef(serializeCardWrite);
  serializeCardWriteRef.current = serializeCardWrite;

  const queueRef = useRef<AutosaveQueue<PendingMap, CharacterDetail | undefined> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new AutosaveQueue(
      (id, snapshot) =>
        serializeCardWriteRef.current(async () => {
          // One request per entry, awaited in turn: each reads the PNG the previous wrote,
          // so concurrent edits to two entries can no longer overwrite one another.
          let detail: CharacterDetail | undefined;
          for (const key of Object.keys(snapshot)) {
            const edit = snapshot[Number(key)];
            if (edit) detail = await characterBookApi.saveEntry(id, Number(key), edit.patch);
          }
          return detail;
        }),
      SAVE_DELAY,
      {
        onSaved: (_id, snapshot, detail) => {
          // Drop the overlay only for entries with no newer edit since this snapshot was
          // taken; a higher generation keeps its overlay and its own scheduled save.
          const next = { ...pendingRef.current };
          for (const key of Object.keys(snapshot)) {
            const uid = Number(key);
            const sent = snapshot[uid];
            if (sent && next[uid]?.gen === sent.gen) delete next[uid];
          }
          pendingRef.current = next;
          setTick((n) => n + 1);
          if (detail) onSavedRef.current(detail);
        },
        onFailed: (_id, error) => onErrorRef.current(error.message),
      },
    );
  }
  const queue = queueRef.current;

  // Flush any pending write on unmount, or the last edit before leaving the card is lost.
  useEffect(() => {
    registerPersistence?.({
      flush: () => queue.flush(avatar),
      retry: () => queue.retry(avatar),
    });
    return () => {
      registerPersistence?.(null);
      void queue.flushAll().catch(() => {});
    };
  }, [avatar, queue, registerPersistence]);

  // Kept the same array until the entries or an overlay change: a caller that compares
  // them (the Studio's list of changes) must not see a new book on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tick is when the overlay changed
  const merged = useMemo(
    () =>
      entries.map((entry) => {
        const edit = pendingRef.current[entry.uid];
        return edit ? { ...entry, ...edit.patch } : entry;
      }),
    [entries, tick],
  );

  function run(work: () => Promise<CharacterDetail>) {
    setBusy(true);
    queue
      .runSerialized(avatar, () => serializeCardWriteRef.current(work))
      .then(onSaved)
      .catch((err) => onError((err as Error).message))
      .finally(() => setBusy(false));
  }

  function updateEntry(uid: number, patch: Partial<WorldInfoEntry>) {
    const current = pendingRef.current[uid];
    pendingRef.current = {
      ...pendingRef.current,
      [uid]: { patch: { ...current?.patch, ...patch }, gen: (current?.gen ?? 0) + 1 },
    };
    setTick((n) => n + 1);
    queue.schedule(avatar, queue.nextRevision(avatar), pendingRef.current);
  }

  /** Adds an entry; resolves to its uid once it exists, or null when adding failed. */
  function addEntry(): Promise<number | null> {
    let uid: number | null = null;
    return new Promise((resolve) => {
      setBusy(true);
      queue
        .runSerialized(avatar, () =>
          serializeCardWriteRef.current(() =>
            characterBookApi.addEntry(avatar).then((result) => {
              uid = result.uid;
              return result.detail;
            }),
          ),
        )
        .then(onSaved)
        .catch((err) => onError((err as Error).message))
        .finally(() => {
          setBusy(false);
          resolve(uid);
        });
    });
  }

  function deleteEntry(uid: number) {
    // No point saving a pending edit for an entry that is about to be deleted; dropping
    // it before the serialized delete also stops the flush re-creating its write.
    if (pendingRef.current[uid]) {
      const next = { ...pendingRef.current };
      delete next[uid];
      pendingRef.current = next;
      setTick((n) => n + 1);
    }
    run(() => characterBookApi.removeEntry(avatar, uid));
  }

  function reorder(uids: number[]) {
    run(() => characterBookApi.saveBook(avatar, { displayOrder: uids }));
  }

  return { entries: merged, busy, addEntry, updateEntry, deleteEntry, reorder };
}

export function EmbeddedBook(props: EmbeddedBookProps) {
  const book = useEmbeddedBook(props);
  return (
    <LorebookEditor
      entries={book.entries}
      busy={book.busy}
      onAddEntry={() => void book.addEntry()}
      onUpdateEntry={book.updateEntry}
      onDeleteEntry={book.deleteEntry}
      onReorder={book.reorder}
    />
  );
}
