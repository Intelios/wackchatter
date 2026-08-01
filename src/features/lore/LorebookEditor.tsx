/**
 * The lorebook editor.
 *
 * ONE component for both kinds of book — the standalone files in data/lorebooks and the
 * `character_book` embedded in a card. The entry form is ~20 controls with semantics that
 * are easy to get subtly wrong; two copies would drift, and drift here is invisible,
 * because a book would then behave differently depending on which screen you edited it
 * in. Persistence is callbacks, so the two callers can differ where they actually differ.
 *
 * Both callers hand it normalised `WorldInfoEntry` values, which is required anyway —
 * the activation engine consumes that shape — so sharing means one conversion boundary
 * rather than two.
 */

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WiLogic, WiPosition, WiRole, WorldInfoEntry } from '@shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS, WI_LOGIC, WI_POSITION, WI_ROLE } from '@shared/types/worldinfo.ts';
import { type ReactNode, useMemo, useState } from 'react';
import {
  CheckField,
  KeyField,
  NumberField,
  SelectField,
  TextField,
  TriCheckField,
} from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { TrashIcon } from '../../layout/icons.tsx';
import './LorebookEditor.css';

const POSITION_OPTIONS: ReadonlyArray<{ label: string; value: WiPosition }> = [
  { label: 'Before character', value: WI_POSITION.before },
  { label: 'After character', value: WI_POSITION.after },
  { label: 'At depth', value: WI_POSITION.atDepth },
  { label: "Author's Note top (→ before)", value: WI_POSITION.ANTop },
  { label: "Author's Note bottom (→ after)", value: WI_POSITION.ANBottom },
  { label: 'Examples top (→ before)', value: WI_POSITION.EMTop },
  { label: 'Examples bottom (→ after)', value: WI_POSITION.EMBottom },
  { label: 'Outlet (→ before)', value: WI_POSITION.outlet },
];

const LOGIC_OPTIONS: ReadonlyArray<{ label: string; value: WiLogic }> = [
  { label: 'AND ANY — at least one secondary', value: WI_LOGIC.AND_ANY },
  { label: 'AND ALL — every secondary', value: WI_LOGIC.AND_ALL },
  { label: 'NOT ANY — no secondary', value: WI_LOGIC.NOT_ANY },
  { label: 'NOT ALL — at least one missing', value: WI_LOGIC.NOT_ALL },
];

const ROLE_OPTIONS: ReadonlyArray<{ label: string; value: WiRole }> = [
  { label: 'System', value: WI_ROLE.SYSTEM },
  { label: 'User', value: WI_ROLE.USER },
  { label: 'Assistant', value: WI_ROLE.ASSISTANT },
];

type SortMode = 'display' | 'order' | 'label';

const SORT_OPTIONS: ReadonlyArray<{ label: string; value: SortMode }> = [
  { label: 'Custom order', value: 'display' },
  { label: 'By insertion order', value: 'order' },
  { label: 'Alphabetical', value: 'label' },
];

function labelFor(entry: WorldInfoEntry): string {
  return (
    entry.comment?.trim() || entry.key.find((key) => key.trim())?.trim() || `Entry ${entry.uid}`
  );
}

/* --- the list ------------------------------------------------------------ */

interface EntryRowProps {
  entry: WorldInfoEntry;
  selected: boolean;
  draggable: boolean;
  onSelect: () => void;
  onToggle: () => void;
}

function EntryRow({ entry, selected, draggable, onSelect, onToggle }: EntryRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.uid,
    disabled: !draggable,
  });

  return (
    <li
      ref={setNodeRef}
      className="lore-row"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-dragging={isDragging}
      data-enabled={!entry.disable}
      data-selected={selected}
    >
      <button
        type="button"
        className="lore-row__grip"
        aria-label={`Reorder ${labelFor(entry)}`}
        disabled={!draggable}
        {...attributes}
        {...listeners}
      >
        <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" fill="currentColor">
          <circle cx="2" cy="3" r="1.3" />
          <circle cx="8" cy="3" r="1.3" />
          <circle cx="2" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="2" cy="13" r="1.3" />
          <circle cx="8" cy="13" r="1.3" />
        </svg>
      </button>

      <label className="lore-row__check">
        <input
          type="checkbox"
          checked={!entry.disable}
          onChange={onToggle}
          aria-label={`Enable ${labelFor(entry)}`}
        />
      </label>

      <button type="button" className="lore-row__main" onClick={onSelect}>
        <span className="lore-row__name">{labelFor(entry)}</span>
        <span className="lore-row__tags">
          {entry.constant ? <span className="lore-tag lore-tag--constant">constant</span> : null}
          {entry.position === WI_POSITION.atDepth ? (
            <span className="lore-tag lore-tag--depth">@{entry.depth}</span>
          ) : null}
          {entry.group ? <span className="lore-tag">{entry.group}</span> : null}
          {entry.vectorized ? <span className="lore-tag lore-tag--warn">vector</span> : null}
        </span>
      </button>

      <span className="lore-row__order">{entry.order}</span>
    </li>
  );
}

/* --- the entry form ------------------------------------------------------ */

interface EntryFormProps {
  entry: WorldInfoEntry;
  globals: { caseSensitive: boolean; matchWholeWords: boolean; depth: number };
  onChange: (patch: Partial<WorldInfoEntry>) => void;
  onDelete: () => void;
}

function EntryForm({ entry, globals, onChange, onDelete }: EntryFormProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="lore-form">
      <TextField
        label="Memo"
        value={entry.comment}
        onChange={(comment) => onChange({ comment })}
        placeholder="What this entry is, for your eyes only"
        hint="Never sent to the model — it names the entry in this list."
      />

      <TextField
        label="Content"
        value={entry.content}
        onChange={(content) => onChange({ content })}
        multiline
        rows={6}
        placeholder="What the model is told when this entry fires."
        hint="Macros like {{char}} are expanded when the prompt is built."
      />

      <CheckField
        label="Always active (constant)"
        checked={entry.constant}
        onChange={(constant) => onChange({ constant })}
        hint="Fires every turn without scanning for keywords."
      />

      {!entry.constant ? (
        <>
          <KeyField
            label="Keys"
            value={entry.key}
            onChange={(key) => onChange({ key })}
            hint="Any one of these activates the entry. A /pattern/flags key is a regex."
          />

          <CheckField
            label="Require secondary keys"
            checked={entry.selective}
            onChange={(selective) => onChange({ selective })}
          />

          {entry.selective ? (
            <>
              <KeyField
                label="Secondary keys"
                value={entry.keysecondary}
                onChange={(keysecondary) => onChange({ keysecondary })}
              />
              <SelectField<WiLogic>
                label="Secondary logic"
                value={entry.selectiveLogic}
                options={LOGIC_OPTIONS}
                onChange={(selectiveLogic) => onChange({ selectiveLogic })}
                hint="Applied once a primary key has matched."
              />
            </>
          ) : null}
        </>
      ) : null}

      <Section title="Placement">
        <SelectField<WiPosition>
          label="Position"
          value={entry.position}
          options={POSITION_OPTIONS}
          onChange={(position) => onChange({ position })}
          hint="Positions marked → are not supported here and are folded to the shown one rather than dropped."
        />

        <div className="field-row">
          <NumberField
            label="Insertion order"
            value={entry.order}
            onChange={(order) => onChange({ order })}
            hint="Higher sits closer to the chat. Ties are fine."
          />
          {entry.position === WI_POSITION.atDepth ? (
            <NumberField
              label="Depth"
              value={entry.depth}
              min={0}
              onChange={(depth) => onChange({ depth })}
              hint="Messages back from the end. 0 = after the last."
            />
          ) : null}
        </div>

        {entry.position === WI_POSITION.atDepth ? (
          <SelectField<WiRole>
            label="Role"
            value={entry.role}
            options={ROLE_OPTIONS}
            onChange={(role) => onChange({ role })}
          />
        ) : null}
      </Section>

      <Section title="Matching">
        <NumberField
          label="Scan depth"
          value={entry.scanDepth ?? globals.depth}
          min={0}
          onChange={(scanDepth) => onChange({ scanDepth })}
          hint={`Messages to search. Global default is ${globals.depth}. 0 means this entry never scans.`}
        />
        {entry.scanDepth !== null ? (
          <button
            type="button"
            className="wc-button wc-button--ghost lore-form__inherit"
            onClick={() => onChange({ scanDepth: null })}
          >
            Inherit the global scan depth
          </button>
        ) : null}

        <TriCheckField
          label="Case sensitive"
          value={entry.caseSensitive}
          inherited={globals.caseSensitive}
          onChange={(caseSensitive) => onChange({ caseSensitive })}
        />
        <TriCheckField
          label="Match whole words"
          value={entry.matchWholeWords}
          inherited={globals.matchWholeWords}
          onChange={(matchWholeWords) => onChange({ matchWholeWords })}
          hint="Multi-word keys ignore this and match as substrings, matching SillyTavern."
        />
      </Section>

      <Section title="Chance and groups">
        <CheckField
          label="Use probability"
          checked={entry.useProbability}
          onChange={(useProbability) => onChange({ useProbability })}
        />
        {entry.useProbability ? (
          <NumberField
            label="Probability (%)"
            value={entry.probability}
            min={0}
            max={100}
            onChange={(probability) => onChange({ probability })}
            hint="Rolled once per turn, seeded — a regenerate sees the same result."
          />
        ) : null}

        <TextField
          label="Inclusion group"
          value={entry.group}
          onChange={(group) => onChange({ group })}
          placeholder="weather"
          hint="Only one entry from a group fires per turn. Comma-separate for several groups."
        />

        {entry.group ? (
          <div className="field-row">
            <NumberField
              label="Group weight"
              value={entry.groupWeight}
              min={0}
              onChange={(groupWeight) => onChange({ groupWeight })}
            />
            <CheckField
              label="Always win"
              checked={entry.groupOverride}
              onChange={(groupOverride) => onChange({ groupOverride })}
              hint="Beats weight. Highest order wins among several."
            />
          </div>
        ) : null}
      </Section>

      <Section title="Recursion and budget">
        <CheckField
          label="Cannot be triggered by other entries"
          checked={entry.excludeRecursion}
          onChange={(excludeRecursion) => onChange({ excludeRecursion })}
        />
        <CheckField
          label="Cannot trigger other entries"
          checked={entry.preventRecursion}
          onChange={(preventRecursion) => onChange({ preventRecursion })}
        />
        <CheckField
          label="Only after recursion has started"
          checked={Boolean(entry.delayUntilRecursion)}
          onChange={(on) => onChange({ delayUntilRecursion: on })}
        />
        <CheckField
          label="Ignore the token budget"
          checked={entry.ignoreBudget}
          onChange={(ignoreBudget) => onChange({ ignoreBudget })}
          hint="Always included, even once the lore budget is spent."
        />
        {entry.vectorized ? (
          <p className="wc-hint lore-form__warn">
            This entry is marked for vector search, which this app does not do — so it will never
            fire. It is preserved exactly as it was for SillyTavern.
          </p>
        ) : null}
      </Section>

      <div className="lore-form__footer">
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger"
          onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
        >
          <TrashIcon />
          {confirmDelete ? 'Click again to delete' : 'Delete entry'}
        </button>
      </div>
    </div>
  );
}

/* --- the editor ---------------------------------------------------------- */

interface LorebookEditorProps {
  entries: WorldInfoEntry[];
  /** Global scan settings, so an entry can show what "inherit" resolves to. */
  globals?: { caseSensitive: boolean; matchWholeWords: boolean; depth: number };
  onAddEntry: () => void;
  onUpdateEntry: (uid: number, patch: Partial<WorldInfoEntry>) => void;
  onDeleteEntry: (uid: number) => void;
  /** Called with the new uid order when a row is dragged. */
  onReorder: (uids: number[]) => void;
  /** Book-level controls — the only genuine fork between the two callers. */
  bookFields?: ReactNode;
  busy?: boolean;
}

export function LorebookEditor({
  entries,
  globals,
  onAddEntry,
  onUpdateEntry,
  onDeleteEntry,
  onReorder,
  bookFields,
  busy,
}: LorebookEditorProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [sort, setSort] = useState<SortMode>('display');

  const resolvedGlobals = globals ?? {
    caseSensitive: DEFAULT_WI_SETTINGS.caseSensitive,
    matchWholeWords: DEFAULT_WI_SETTINGS.matchWholeWords,
    depth: DEFAULT_WI_SETTINGS.depth,
  };

  const sorted = useMemo(() => {
    const list = [...entries];
    if (sort === 'order') return list.sort((a, b) => b.order - a.order || a.uid - b.uid);
    if (sort === 'label') return list.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
    return list.sort((a, b) => a.displayIndex - b.displayIndex || a.uid - b.uid);
  }, [entries, sort]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Dragging is only offered in custom order. A drop rewrites `displayIndex`, and while
  // the list is sorted by something else the result would not be where it was dropped —
  // the row would spring back the moment the list re-sorted.
  const draggable = sort === 'display';

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = sorted.findIndex((entry) => entry.uid === active.id);
    const to = sorted.findIndex((entry) => entry.uid === over.id);
    if (from === -1 || to === -1) return;

    const next = [...sorted];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onReorder(next.map((entry) => entry.uid));
  }

  const active = selected === null ? null : entries.find((entry) => entry.uid === selected);

  return (
    <div className="lore-editor">
      {bookFields}

      <div className="lore-editor__toolbar">
        <select
          className="wc-select lore-editor__sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as SortMode)}
          aria-label="Sort entries"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="button" className="wc-button" onClick={onAddEntry} disabled={busy}>
          Add entry
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="wc-empty">
          <span>No entries yet.</span>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sorted.map((entry) => entry.uid)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="lore-editor__list">
              {sorted.map((entry) => (
                <EntryRow
                  key={entry.uid}
                  entry={entry}
                  selected={selected === entry.uid}
                  draggable={draggable}
                  onSelect={() => setSelected(selected === entry.uid ? null : entry.uid)}
                  onToggle={() => onUpdateEntry(entry.uid, { disable: !entry.disable })}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {active ? (
        <EntryForm
          // Remounts when a different entry is picked, so the local buffers inside
          // NumberField and KeyField start from the new entry rather than the old one.
          key={active.uid}
          entry={active}
          globals={resolvedGlobals}
          onChange={(patch) => onUpdateEntry(active.uid, patch)}
          onDelete={() => {
            onDeleteEntry(active.uid);
            setSelected(null);
          }}
        />
      ) : null}
    </div>
  );
}
