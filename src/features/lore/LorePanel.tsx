/**
 * The Lore tab: pick a standalone lorebook, edit it, and see which books are active in
 * the current chat.
 *
 * Standalone books are saved whole — unlike the embedded book, the file is ours alone and
 * a whole-file write cannot corrupt a character card. The write is debounced so typing in
 * the content box isn't one request per keystroke.
 */

import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { useState } from 'react';
import { NumberField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { Select } from '../../components/Select.tsx';
import { lorebookApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { LorebookEditor } from './LorebookEditor.tsx';
import type { ActiveBook } from './useLorebooks.ts';
import { useLorebookWorkbench } from './useLorebookWorkbench.ts';
import './LorePanel.css';

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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bench = useLorebookWorkbench({
    selected,
    setSelected,
    onBooksChanged,
    onBookEdited,
    registerPersistence,
  });
  const { book, entries, error, selectBook } = bench;

  async function handleCreate() {
    await bench.create();
  }

  async function handleDelete() {
    await bench.remove();
    setConfirmDelete(false);
  }

  async function handleImport(file: File) {
    await bench.importFile(file);
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
          <Select
            label="Lorebook"
            placeholder="Select a lorebook…"
            value={selected ?? ''}
            options={books.map((summary) => ({
              value: summary.id,
              label: summary.name,
              description: `${summary.entryCount} ${summary.entryCount === 1 ? 'entry' : 'entries'}`,
            }))}
            onChange={(id) => void selectBook(id || null)}
          />
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
            <button type="button" className="wc-button wc-button--ghost" onClick={bench.retry}>
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
          onAddEntry={() => void bench.addEntry()}
          onUpdateEntry={bench.updateEntry}
          onDeleteEntry={bench.deleteEntry}
          onReorder={bench.reorder}
          bookFields={
            <RenameField
              key={selected}
              name={selected}
              onRename={(name) => void bench.rename(name)}
            />
          }
        />
      ) : null}
    </div>
  );
}
