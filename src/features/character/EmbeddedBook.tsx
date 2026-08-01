/**
 * The card's embedded lorebook, inside the character editor.
 *
 * Thin: it owns the per-entry requests and nothing else. The editing UI is the same
 * `LorebookEditor` the Lore tab uses, so an entry cannot behave differently depending on
 * which screen it was edited from.
 *
 * Every mutation is one request that names one uid. The server reads the stored PNG,
 * changes that entry and writes it back — no book assembled here ever reaches the card.
 */

import type { CharacterDetail } from '@shared/types/card.ts';
import type { WorldInfoEntry } from '@shared/types/worldinfo.ts';
import { useRef, useState } from 'react';
import { characterBookApi } from '../../lib/api.ts';
import { LorebookEditor } from '../lore/LorebookEditor.tsx';

/** Field edits are debounced; structural ones (add/delete/reorder) go straight out. */
const SAVE_DELAY = 600;

interface EmbeddedBookProps {
  avatar: string;
  entries: WorldInfoEntry[];
  onSaved: (detail: CharacterDetail) => void;
  onError: (message: string) => void;
}

export function EmbeddedBook({ avatar, entries, onSaved, onError }: EmbeddedBookProps) {
  const [busy, setBusy] = useState(false);
  // Local overlay so typing feels immediate while the debounced write is in flight.
  const [pending, setPending] = useState<Record<number, Partial<WorldInfoEntry>>>({});
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const merged = entries.map((entry) =>
    pending[entry.uid] ? { ...entry, ...pending[entry.uid] } : entry,
  );

  function run(work: () => Promise<CharacterDetail>) {
    setBusy(true);
    work()
      .then(onSaved)
      .catch((err) => onError((err as Error).message))
      .finally(() => setBusy(false));
  }

  function updateEntry(uid: number, patch: Partial<WorldInfoEntry>) {
    setPending((current) => ({ ...current, [uid]: { ...current[uid], ...patch } }));

    const existing = timers.current.get(uid);
    if (existing) clearTimeout(existing);

    timers.current.set(
      uid,
      setTimeout(() => {
        timers.current.delete(uid);
        setPending((current) => {
          const queued = current[uid];
          if (queued) {
            characterBookApi
              .saveEntry(avatar, uid, queued)
              .then(onSaved)
              .catch((err) => onError((err as Error).message));
          }
          // The overlay is dropped here: the response carries the authoritative card, and
          // keeping a stale local copy on top of it would resurrect the old value.
          const { [uid]: _sent, ...rest } = current;
          return rest;
        });
      }, SAVE_DELAY),
    );
  }

  return (
    <LorebookEditor
      entries={merged}
      busy={busy}
      onAddEntry={() => run(() => characterBookApi.addEntry(avatar).then((r) => r.detail))}
      onUpdateEntry={updateEntry}
      onDeleteEntry={(uid) => {
        const timer = timers.current.get(uid);
        if (timer) clearTimeout(timer);
        timers.current.delete(uid);
        run(() => characterBookApi.removeEntry(avatar, uid));
      }}
      onReorder={(uids) => run(() => characterBookApi.saveBook(avatar, { displayOrder: uids }))}
    />
  );
}
