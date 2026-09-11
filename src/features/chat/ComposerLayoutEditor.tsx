import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  COMPOSER_AREAS,
  type ComposerArea,
  type ComposerKind,
  type ComposerLabelMode,
  type ComposerLayout,
  type ComposerLayoutItem,
  MAX_COMPOSER_ROWS,
  moveComposerItem,
  REQUIRED_COMPOSER_CONTROLS,
  removeComposerItem,
} from '@shared/composer/layout.ts';
import { useEffect, useMemo, useState } from 'react';
import { GripIcon, PlusIcon, TrashIcon } from '../../layout/icons.tsx';

export interface ComposerControlSpec {
  id: string;
  label: string;
}

interface Props {
  kind: ComposerKind;
  layout: ComposerLayout;
  controls: ComposerControlSpec[];
  onChange: (layout: ComposerLayout) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
  onReset: () => void;
  saveError: string;
}

function findItem(layout: ComposerLayout, id: string) {
  for (const row of layout.rows)
    for (const area of COMPOSER_AREAS) {
      const index = row[area].findIndex((item) => item.id === id);
      if (index >= 0) return { row, area, index, item: row[area][index]! };
    }
  return null;
}

function SortableTile({
  item,
  label,
  selected,
  onSelect,
}: {
  item: ComposerLayoutItem;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const sortable = useSortable({ id: item.id });
  return (
    <button
      ref={sortable.setNodeRef}
      type="button"
      className="composer-editor__tile"
      data-selected={selected || undefined}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      onClick={onSelect}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <GripIcon />
      <span>{label}</span>
    </button>
  );
}

export function ComposerLayoutEditor({
  kind,
  layout,
  controls,
  onChange,
  onSave,
  onCancel,
  onReset,
  saveError,
}: Props) {
  const [selected, setSelected] = useState<string>('send');
  const [query, setQuery] = useState('');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const byId = useMemo(() => new Map(controls.map((control) => [control.id, control])), [controls]);
  const placed = new Set(
    layout.rows.flatMap((row) =>
      COMPOSER_AREAS.flatMap((area) => row[area].map((item) => item.id)),
    ),
  );
  const available = controls.filter(
    (control) =>
      !placed.has(control.id) && control.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selection = findItem(layout, selected);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  function dragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = findItem(layout, String(event.active.id));
    const to = findItem(layout, String(event.over.id));
    if (!from || !to) return;
    onChange(moveComposerItem(layout, from.item.id, to.row.id, to.area, to.index));
  }

  function updateSelected(patch: {
    rowId?: string;
    area?: ComposerArea;
    display?: ComposerLabelMode;
  }) {
    if (!selection) return;
    let next = moveComposerItem(
      layout,
      selected,
      patch.rowId ?? selection.row.id,
      patch.area ?? selection.area,
      selection.index,
    );
    if (patch.display) {
      next = {
        rows: next.rows.map((row) => ({
          ...row,
          left: row.left.map((item) =>
            item.id === selected ? { ...item, display: patch.display! } : item,
          ),
          centre: row.centre.map((item) =>
            item.id === selected ? { ...item, display: patch.display! } : item,
          ),
          right: row.right.map((item) =>
            item.id === selected ? { ...item, display: patch.display! } : item,
          ),
        })),
      };
    }
    onChange(next);
  }

  function addControl(id: string) {
    const last = layout.rows[layout.rows.length - 1]!;
    onChange({
      rows: layout.rows.map((row) =>
        row.id === last.id ? { ...row, left: [...row.left, { id, display: 'icon' }] } : row,
      ),
    });
    setSelected(id);
  }

  return (
    <section
      className="composer-editor"
      aria-label={`Customise ${kind === 'single' ? 'chat' : 'group'} composer`}
    >
      <div className="composer-editor__head">
        <strong>Customise composer</strong>
        <span>Drag controls, or select one and use the options below.</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
        <div className="composer-editor__rows">
          {layout.rows.map((row, rowIndex) => (
            <div className="composer-editor__row" key={row.id}>
              <span className="composer-editor__row-label">Row {rowIndex + 1}</span>
              {COMPOSER_AREAS.map((area) => (
                <div className="composer-editor__area" data-area={area} key={area}>
                  <span className="composer-editor__area-label">{area}</span>
                  <SortableContext
                    items={row[area].map((item) => item.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    {row[area].map((item) => (
                      <SortableTile
                        key={item.id}
                        item={item}
                        label={byId.get(item.id)?.label ?? item.id}
                        selected={selected === item.id}
                        onSelect={() => setSelected(item.id)}
                      />
                    ))}
                  </SortableContext>
                </div>
              ))}
              <button
                type="button"
                className="wc-button wc-button--ghost composer-editor__remove-row"
                disabled={
                  layout.rows.length === 1 || COMPOSER_AREAS.some((area) => row[area].length > 0)
                }
                title="Remove empty row"
                onClick={() =>
                  onChange({ rows: layout.rows.filter((candidate) => candidate.id !== row.id) })
                }
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      </DndContext>

      <div className="composer-editor__tools">
        <div className="composer-editor__picker">
          <input
            className="wc-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a control…"
            aria-label="Find a composer control"
          />
          <div className="composer-editor__available">
            {available.map((control) => (
              <button
                type="button"
                className="wc-button wc-button--ghost"
                key={control.id}
                onClick={() => addControl(control.id)}
              >
                <PlusIcon />
                {control.label}
              </button>
            ))}
            {!available.length ? (
              <span className="wc-hint">All matching controls are placed.</span>
            ) : null}
          </div>
        </div>
        {selection ? (
          <div className="composer-editor__selection">
            <strong>{byId.get(selected)?.label ?? selected}</strong>
            <label>
              Row{' '}
              <select
                value={selection.row.id}
                onChange={(event) => updateSelected({ rowId: event.target.value })}
              >
                {layout.rows.map((row, index) => (
                  <option value={row.id} key={row.id}>
                    {index + 1}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Align{' '}
              <select
                value={selection.area}
                onChange={(event) => updateSelected({ area: event.target.value as ComposerArea })}
              >
                {COMPOSER_AREAS.map((area) => (
                  <option value={area} key={area}>
                    {area}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Style{' '}
              <select
                value={selection.item.display}
                onChange={(event) =>
                  updateSelected({ display: event.target.value as ComposerLabelMode })
                }
              >
                <option value="icon">Icon only</option>
                <option value="label">Icon and label</option>
              </select>
            </label>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={(REQUIRED_COMPOSER_CONTROLS as readonly string[]).includes(selected)}
              onClick={() => onChange(removeComposerItem(layout, selected))}
            >
              <TrashIcon />
              Remove
            </button>
          </div>
        ) : null}
      </div>
      <div className="composer-editor__footer">
        <button
          type="button"
          className="wc-button wc-button--ghost"
          disabled={layout.rows.length >= MAX_COMPOSER_ROWS}
          onClick={() =>
            onChange({
              rows: [...layout.rows, { id: crypto.randomUUID(), left: [], centre: [], right: [] }],
            })
          }
        >
          <PlusIcon />
          Add row
        </button>
        <button type="button" className="wc-button wc-button--ghost" onClick={onReset}>
          Reset layout
        </button>
        <span className="composer-editor__footer-spacer" />
        <button type="button" className="wc-button wc-button--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="wc-button wc-button--primary"
          onClick={() => void onSave()}
        >
          Save
        </button>
      </div>
      {saveError ? (
        <div className="composer__error" role="alert">
          {saveError}
        </div>
      ) : null}
    </section>
  );
}
