/**
 * The Lore tab: pick a standalone lorebook, edit it, and see which books are active in
 * the current chat.
 *
 * Standalone books are saved whole — unlike the embedded book, the file is ours alone and
 * a whole-file write cannot corrupt a character card. The write is debounced so typing in
 * the content box isn't one request per keystroke.
 */

import type {
  LorebookSummary,
  WorldInfoBook,
  WorldInfoEntry,
  WorldInfoSettings,
} from '@shared/types/worldinfo.ts';
import { createWorldInfoEntry } from '@shared/types/worldinfo.ts';
import { bookEntries, nextUid, removeEntry } from '@shared/worldinfo/convert.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NumberField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { lorebookApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';
import { LorebookEditor } from './LorebookEditor.tsx';
import type { ActiveBook } from './useLorebooks.ts';
import './LorePanel.css';

const SAVE_DELAY = 600;

/**
 * The book's name, which is also its filename.
 *
 * Committed on blur or Enter rather than as you type, because renaming is a file move on
 * the server and a card's `extensions.world` points at the old name until it lands —
 * saving per keystroke would leave a trail of half-typed books.
 */
function RenameField({ name, onRename }: { name: string; onRename: (next: string) => void }) {
  const [draft, setDraft] = useState(name);

  return (
    <TextField
      label="Name"
      value={draft}
      onChange={setDraft}
      hint="This is the filename too. Characters link to a book by name, so renaming updates the file."
      onCommit={() => {
        const trimmed = draft.trim();
        if (trimmed && trimmed !== name) onRename(trimmed);
        else setDraft(name);
      }}
    />
  );
}

interface LorePanelProps {
  books: LorebookSummary[];
  settings: WorldInfoSettings;
  onBooksChanged: () => void;
  onSettingsChange: (patch: Partial<WorldInfoSettings>) => void;
  /** Books the engine will actually consult for the open chat. */
  activeBooks: ActiveBook[];
  /** Bumped whenever a book's contents change, so the engine re-reads it. */
  onBookEdited: (id: string) => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
}

export function LorePanel({
  books,
  settings,
  onBooksChanged,
  onSettingsChange,
  activeBooks,
  onBookEdited,
  registerPersistence,
}: LorePanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [book, setBook] = useState<WorldInfoBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  const persist = useCallback(
    (id: string, next: WorldInfoBook) => {
      setBook(next);
      queue.schedule(id, queue.nextRevision(id), next);
    },
    [queue],
  );

  const entries = useMemo(() => (book ? bookEntries(book) : []), [book]);

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

  const update = useCallback(
    (mutate: (current: WorldInfoBook) => WorldInfoBook) => {
      if (!selected || !book) return;
      persist(selected, mutate(book));
    },
    [selected, book, persist],
  );

  async function handleCreate() {
    try {
      const created = await lorebookApi.create('New Lorebook');
      onBooksChanged();
      await selectBook(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete() {
    if (!selected) return;
    try {
      const id = selected;
      await queue.runSerialized(id, () => lorebookApi.remove(id));
      queue.discard(id);
      setSelected(null);
      setConfirmDelete(false);
      onBooksChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleImport(file: File) {
    try {
      const imported = await lorebookApi.import(file);
      onBooksChanged();
      await selectBook(imported.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="lore-panel">
      {activeBooks.length > 0 ? (
        <Section title="Active in this chat" badge={String(activeBooks.length)} defaultOpen>
          <ul className="lore-panel__active">
            {activeBooks.map((active) => (
              <li key={`${active.kind}:${active.name}`}>
                <span className="lore-panel__source">{active.kind}</span>
                <span className="lore-panel__active-name">{active.name}</span>
                <span className="lore-panel__count">{active.entryCount}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Scan settings">
        <div className="field-row">
          <NumberField
            label="Scan depth"
            value={settings.depth}
            min={0}
            onChange={(depth) => onSettingsChange({ depth })}
            hint="Recent messages searched for keywords."
          />
          <NumberField
            label="Budget (%)"
            value={settings.budget}
            min={0}
            max={100}
            onChange={(budget) => onSettingsChange({ budget })}
            hint="Share of the context lore may use."
          />
        </div>
        <div className="field-row">
          <NumberField
            label="Budget cap (tokens)"
            value={settings.budgetCap}
            min={0}
            onChange={(budgetCap) => onSettingsChange({ budgetCap })}
            hint="0 means no cap."
          />
          <NumberField
            label="Max recursion steps"
            value={settings.maxRecursionSteps}
            min={1}
            onChange={(maxRecursionSteps) => onSettingsChange({ maxRecursionSteps })}
          />
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={settings.recursive}
            onChange={(event) => onSettingsChange({ recursive: event.target.checked })}
          />
          <span>Activated entries can trigger other entries</span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={settings.caseSensitive}
            onChange={(event) => onSettingsChange({ caseSensitive: event.target.checked })}
          />
          <span>Case sensitive by default</span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={settings.matchWholeWords}
            onChange={(event) => onSettingsChange({ matchWholeWords: event.target.checked })}
          />
          <span>Match whole words by default</span>
        </label>
      </Section>

      <div className="lore-panel__books">
        <div className="lore-panel__toolbar">
          <select
            className="wc-select"
            value={selected ?? ''}
            onChange={(event) => void selectBook(event.target.value || null)}
            aria-label="Lorebook"
          >
            <option value="">Select a lorebook…</option>
            {books.map((summary) => (
              <option key={summary.id} value={summary.id}>
                {summary.name} ({summary.entryCount})
              </option>
            ))}
          </select>
        </div>

        <div className="lore-panel__actions">
          <button type="button" className="wc-button" onClick={() => void handleCreate()}>
            New
          </button>
          <label className="wc-button">
            Import
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
                event.target.value = '';
              }}
            />
          </label>
          {selected ? (
            <>
              <a className="wc-button" href={lorebookApi.exportUrl(selected)} download>
                Export
              </a>
              {/* Two-click confirm in place — destructive, but never a blocking dialog. */}
              <button
                type="button"
                className="wc-button wc-button--ghost wc-button--danger"
                onClick={() => (confirmDelete ? void handleDelete() : setConfirmDelete(true))}
                onBlur={() => setConfirmDelete(false)}
              >
                {confirmDelete ? 'Sure?' : 'Delete'}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="lore-panel__error">
          {error}{' '}
          {selected ? (
            <button
              type="button"
              className="wc-button wc-button--ghost"
              onClick={() => void queue.retry(selected).catch(() => {})}
            >
              Retry save
            </button>
          ) : null}
        </p>
      ) : null}

      {book && selected ? (
        <LorebookEditor
          key={selected}
          entries={entries}
          globals={settings}
          onAddEntry={() =>
            update((current) => {
              const uid = nextUid(current);
              const entry = createWorldInfoEntry(uid);
              entry.displayIndex = bookEntries(current).length;
              entry.content = 'New entry.';
              return { ...current, entries: { ...current.entries, [String(uid)]: entry } };
            })
          }
          onUpdateEntry={(uid, patch) =>
            update((current) => {
              const existing = current.entries[String(uid)];
              if (!existing) return current;
              const next: WorldInfoEntry = { ...existing, ...patch, uid };
              return { ...current, entries: { ...current.entries, [String(uid)]: next } };
            })
          }
          onDeleteEntry={(uid) => update((current) => removeEntry(current, uid))}
          onReorder={(uids) =>
            update((current) => {
              const next = { ...current.entries };
              uids.forEach((uid, index) => {
                const entry = next[String(uid)];
                if (entry) next[String(uid)] = { ...entry, displayIndex: index };
              });
              return { ...current, entries: next };
            })
          }
          bookFields={
            <RenameField
              key={selected}
              name={selected}
              onRename={async (name) => {
                try {
                  const oldId = selected;
                  const renamed = await queue.runSerialized(oldId, () =>
                    lorebookApi.rename(oldId, name),
                  );
                  queue.discard(oldId);
                  onBooksChanged();
                  setSelected(renamed.id);
                  setError(null);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          }
        />
      ) : null}
    </div>
  );
}
