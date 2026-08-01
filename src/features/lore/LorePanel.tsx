/**
 * The Lore tab: pick a standalone lorebook, edit it, and see which books are active in
 * the current chat.
 *
 * Standalone books are saved whole — unlike the embedded book, the file is ours alone and
 * a whole-file write cannot corrupt a character card. The write is debounced so typing in
 * the content box isn't one request per keystroke.
 */

import type { WorldInfoEntry, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { LorebookSummary, WorldInfoBook } from '@shared/types/worldinfo.ts';
import { createWorldInfoEntry } from '@shared/types/worldinfo.ts';
import { bookEntries, nextUid, removeEntry } from '@shared/worldinfo/convert.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NumberField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { lorebookApi } from '../../lib/api.ts';
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
}

export function LorePanel({
  books,
  settings,
  onBooksChanged,
  onSettingsChange,
  activeBooks,
  onBookEdited,
}: LorePanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [book, setBook] = useState<WorldInfoBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Flush any pending write on unmount, or the last edit before closing the panel is lost.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const persist = useCallback(
    (id: string, next: WorldInfoBook) => {
      setBook(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        lorebookApi
          .save(id, next)
          .then(() => {
            setError(null);
            onBookEdited(id);
            onBooksChanged();
          })
          .catch((err) => setError((err as Error).message));
      }, SAVE_DELAY);
    },
    [onBookEdited, onBooksChanged],
  );

  const entries = useMemo(() => (book ? bookEntries(book) : []), [book]);

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
      setSelected(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete() {
    if (!selected) return;
    try {
      await lorebookApi.remove(selected);
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
      setSelected(imported.id);
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
            onChange={(event) => setSelected(event.target.value || null)}
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

      {error ? <p className="lore-panel__error">{error}</p> : null}

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
                  const renamed = await lorebookApi.rename(selected, name);
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
