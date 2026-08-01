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
import { useEffect, useRef, useState } from 'react';
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

interface EmbeddedBookProps {
  avatar: string;
  entries: WorldInfoEntry[];
  onSaved: (detail: CharacterDetail) => void;
  onError: (message: string) => void;
  serializeCardWrite: <T>(task: () => Promise<T>) => Promise<T>;
  registerPersistence?: (controls: PersistenceControls | null) => void;
}

export function EmbeddedBook({
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
  const [, setTick] = useState(0);
  const revisionRef = useRef(0);

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

  const merged = entries.map((entry) => {
    const edit = pendingRef.current[entry.uid];
    return edit ? { ...entry, ...edit.patch } : entry;
  });

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
    revisionRef.current += 1;
    queue.schedule(avatar, revisionRef.current, pendingRef.current);
  }

  return (
    <LorebookEditor
      entries={merged}
      busy={busy}
      onAddEntry={() => run(() => characterBookApi.addEntry(avatar).then((r) => r.detail))}
      onUpdateEntry={updateEntry}
      onDeleteEntry={(uid) => {
        // No point saving a pending edit for an entry that is about to be deleted; dropping
        // it before the serialized delete also stops the flush re-creating its write.
        if (pendingRef.current[uid]) {
          const next = { ...pendingRef.current };
          delete next[uid];
          pendingRef.current = next;
          setTick((n) => n + 1);
        }
        run(() => characterBookApi.removeEntry(avatar, uid));
      }}
      onReorder={(uids) => run(() => characterBookApi.saveBook(avatar, { displayOrder: uids }))}
    />
  );
}
