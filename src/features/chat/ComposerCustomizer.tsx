/**
 * The composer's customiser — a Touch Bar–style arrangement surface.
 *
 * The live tray *is* the canvas: the real controls stay in place and visibly move as you
 * drag them, so what you arrange is what you will get. A palette of everything not yet
 * placed sits above the tray; drag a control down out of it to add it, drag a placed one
 * back up to remove it, and drop one in the gap between rows to start a new row.
 *
 * Nothing here writes to the tray on its own — every move is a pure transform from
 * `shared/composer/layout.ts`, handed back through `onChange`, so the parent keeps the one
 * draft and the same Save/Cancel contract the previous editor had.
 *
 * Each tile is a visual layer plus a transparent activator button rather than one button
 * wrapping the control: the preview inside is a real control, and most of those are buttons
 * — which cannot legally nest. The activator carries the drag listeners, the focus and the
 * accessible name; the preview is `inert` and takes no pointer events.
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
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
  findComposerItem,
  insertComposerItem,
  insertComposerRow,
  MAX_COMPOSER_ROWS,
  moveComposerItem,
  pruneEmptyComposerRows,
  REQUIRED_COMPOSER_CONTROLS,
  removeComposerItem,
  setComposerItemDisplay,
} from '@shared/composer/layout.ts';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { GridIcon, PlusIcon, SearchIcon, TrashIcon } from '../../layout/icons.tsx';

export interface ComposerControlSpec {
  id: string;
  label: string;
}

interface Props {
  kind: ComposerKind;
  layout: ComposerLayout;
  /** Every control the composer can offer, placed or not. */
  controls: ComposerControlSpec[];
  /** Draw one real control — the same one the tray shows, so the preview is exact. */
  renderControl: (item: ComposerLayoutItem) => ReactNode;
  onChange: (layout: ComposerLayout) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
  onReset: () => void;
  saveError: string;
}

/** Palette drags are namespaced so a palette id can never collide with a placed one. */
const PALETTE_PREFIX = 'palette:';
const REQUIRED = REQUIRED_COMPOSER_CONTROLS as readonly string[];

/** dnd-kit's reorder transition is inline, so the reduced-motion token cannot reach it. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * Is the pointer over this element?
 *
 * Used for "drag up to the palette to remove" instead of a droppable: the palette is a wide
 * band and `closestCenter` can prefer a tray control near its edge, so the reliable test is
 * the pointer's own position. A keyboard drag has no pointer and answers false.
 */
function pointerInside(event: DragMoveEvent, element: HTMLElement | null): boolean {
  if (!element) return false;
  const activator = event.activatorEvent as PointerEvent;
  if (typeof activator?.clientX !== 'number') return false;
  const rect = element.getBoundingClientRect();
  const x = activator.clientX + event.delta.x;
  const y = activator.clientY + event.delta.y;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Compose the sensor's own Enter/Space handling with a click-to-activate fallback. */
type SensorKeyDown = (event: KeyboardEvent) => void;

function pressHandler(sensorKeyDown: SensorKeyDown | undefined, activate: () => void) {
  return (event: React.KeyboardEvent) => {
    if (sensorKeyDown) sensorKeyDown(event.nativeEvent);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  };
}

function SortableChip({
  item,
  label,
  selected,
  reducedMotion,
  onSelect,
  children,
}: {
  item: ComposerLayoutItem;
  label: string;
  selected: boolean;
  reducedMotion: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const sortable = useSortable({ id: item.id, data: { kind: 'placed', id: item.id } });
  return (
    <div
      ref={sortable.setNodeRef}
      className="composer-editor__chip"
      data-selected={selected || undefined}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: reducedMotion ? undefined : sortable.transition,
      }}
    >
      <span className="composer-editor__chip-face" inert aria-hidden="true">
        {children}
      </span>
      <button
        ref={sortable.setActivatorNodeRef}
        type="button"
        className="composer-editor__chip-hit"
        title={label}
        aria-label={label}
        onClick={onSelect}
        {...sortable.attributes}
        {...sortable.listeners}
        onKeyDown={pressHandler(
          sortable.listeners?.onKeyDown as SensorKeyDown | undefined,
          onSelect,
        )}
      />
    </div>
  );
}

function DroppableArea({
  rowId,
  area,
  itemIds,
  children,
}: {
  rowId: string;
  area: ComposerArea;
  itemIds: string[];
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `area:${rowId}:${area}`,
    data: { kind: 'area', rowId, area },
  });
  return (
    <div
      ref={setNodeRef}
      className="composer-editor__area"
      data-area={area}
      data-over={isOver || undefined}
    >
      <SortableContext items={itemIds} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </div>
  );
}

/** The gap between rows — drop a control here and it starts a row of its own. */
function RowDivider({ index, canAdd }: { index: number; canAdd: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `divider:${index}`,
    data: { kind: 'divider', index },
    disabled: !canAdd,
  });
  if (!canAdd) return null;
  return (
    <div
      ref={setNodeRef}
      className="composer-editor__divider"
      data-over={isOver || undefined}
      aria-hidden="true"
    />
  );
}

function PaletteItem({
  control,
  reducedMotion,
  onAdd,
  children,
}: {
  control: ComposerControlSpec;
  reducedMotion: boolean;
  onAdd: () => void;
  children: ReactNode;
}) {
  const draggable = useDraggable({
    id: `${PALETTE_PREFIX}${control.id}`,
    data: { kind: 'paletteItem', id: control.id },
  });
  return (
    <div
      ref={draggable.setNodeRef}
      className="composer-editor__palette-item"
      style={{
        transform: CSS.Translate.toString(draggable.transform),
        transition: reducedMotion ? undefined : 'transform var(--wc-duration-fast) ease',
      }}
    >
      <span className="composer-editor__palette-face" inert aria-hidden="true">
        {children}
      </span>
      <span className="composer-editor__palette-label">{control.label}</span>
      <button
        ref={draggable.setActivatorNodeRef}
        type="button"
        className="composer-editor__palette-hit"
        title={`Add ${control.label}`}
        aria-label={`Add ${control.label}`}
        onClick={onAdd}
        {...draggable.attributes}
        {...draggable.listeners}
        onKeyDown={pressHandler(draggable.listeners?.onKeyDown as SensorKeyDown | undefined, onAdd)}
      />
    </div>
  );
}

export function ComposerCustomizer({
  kind,
  layout,
  controls,
  renderControl,
  onChange,
  onSave,
  onCancel,
  onReset,
  saveError,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overPalette, setOverPalette] = useState(false);
  const [notice, setNotice] = useState('');
  const paletteRef = useRef<HTMLDivElement>(null);
  /**
   * The palette hit is also kept in a ref: the last pointermove and the drop can land in
   * the same frame, and reading state in `onDragEnd` would then see the previous value.
   */
  const overPaletteRef = useRef(false);
  const justDragged = useRef(false);
  const reducedMotion = usePrefersReducedMotion();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = useMemo(() => new Map(controls.map((control) => [control.id, control])), [controls]);
  const placed = useMemo(() => {
    const ids = new Set<string>();
    for (const row of layout.rows)
      for (const area of COMPOSER_AREAS) for (const item of row[area]) ids.add(item.id);
    return ids;
  }, [layout]);
  const available = controls.filter(
    (control) =>
      !placed.has(control.id) && control.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selection = selected ? findComposerItem(layout, selected) : null;
  const canAddRow = layout.rows.length < MAX_COMPOSER_ROWS;
  const activeControl = activeId?.startsWith(PALETTE_PREFIX)
    ? activeId.slice(PALETTE_PREFIX.length)
    : activeId;
  const activeLabel = activeControl ? (byId.get(activeControl)?.label ?? activeControl) : '';

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  /**
   * Every structural change lands here so blank rows never reach the tray.
   *
   * `pruneEmptyComposerRows` returns the same object when it finds nothing to drop, which
   * also lets a no-op drag skip the parent's re-render.
   */
  function commit(next: ComposerLayout) {
    if (next === layout) return;
    onChange(pruneEmptyComposerRows(next));
  }

  function finishDrag() {
    setActiveId(null);
    setOverPalette(false);
    overPaletteRef.current = false;
    // The click that follows a pointer drag would otherwise re-select (or re-add) the
    // control that was just moved.
    justDragged.current = true;
    window.setTimeout(() => {
      justDragged.current = false;
    }, 0);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
    setNotice('');
    justDragged.current = true;
  }

  function handleDragMove(event: DragMoveEvent) {
    const dragging = event.active.data.current?.kind === 'placed';
    const inside = dragging && pointerInside(event, paletteRef.current);
    overPaletteRef.current = inside;
    setOverPalette((previous) => (previous === inside ? previous : inside));
  }

  function handleDragEnd(event: DragEndEvent) {
    const dragged = event.active.data.current as { kind?: string; id?: string } | undefined;
    const overData = event.over?.data.current as
      | { kind?: string; id?: string; rowId?: string; area?: ComposerArea; index?: number }
      | undefined;

    // The palette test uses the pointer, so it is decided before `over` is consulted.
    const onPalette = dragged?.kind === 'placed' && overPaletteRef.current;
    finishDrag();

    if (onPalette && dragged?.id) {
      if (REQUIRED.includes(dragged.id)) {
        setNotice('Menu and Send always stay in the tray.');
        return;
      }
      commit(removeComposerItem(layout, dragged.id));
      return;
    }

    if (!event.over || !overData) return;

    if (overData.kind === 'divider') {
      if (!dragged?.id) return;
      placeInNewRow(dragged.id, dragged.kind === 'placed', overData.index ?? layout.rows.length);
      return;
    }

    let rowId: string | undefined;
    let area: ComposerArea | undefined;
    let index: number | undefined;
    if (overData.kind === 'area') {
      rowId = overData.rowId;
      area = overData.area;
    } else if (overData.kind === 'placed' && overData.id) {
      const target = findComposerItem(layout, overData.id);
      if (target) {
        rowId = target.rowId;
        area = target.area;
        index = target.index;
      }
    }
    if (!rowId || !area) return;

    if (dragged?.kind === 'paletteItem' && dragged.id) {
      commit(insertComposerItem(layout, dragged.id, rowId, area, index));
    } else if (dragged?.kind === 'placed' && dragged.id) {
      commit(moveComposerItem(layout, dragged.id, rowId, area, index));
    }
  }

  /** A control dropped in a gap gets a row of its own, inserted at that gap. */
  function placeInNewRow(id: string, alreadyPlaced: boolean, index: number) {
    const rowId = crypto.randomUUID();
    const withRow = insertComposerRow(layout, rowId, index);
    if (withRow === layout) return;
    const next = alreadyPlaced
      ? moveComposerItem(withRow, id, rowId, 'left', 0)
      : insertComposerItem(withRow, id, rowId, 'left', 0);
    commit(next);
  }

  function moveToNewRow(id: string) {
    setNotice('');
    placeInNewRow(id, true, layout.rows.length);
    setSelected(id);
  }

  function addControl(id: string) {
    if (justDragged.current) return;
    if (findComposerItem(layout, id)) return;
    const row = layout.rows[layout.rows.length - 1]!;
    commit(insertComposerItem(layout, id, row.id, 'left'));
    setSelected(id);
    setNotice('');
  }

  function updateSelected(patch: {
    rowId?: string;
    area?: ComposerArea;
    display?: ComposerLabelMode;
  }) {
    if (!selected || !selection) return;
    let next = layout;
    const rowId = patch.rowId ?? selection.rowId;
    const area = patch.area ?? selection.area;
    if (rowId !== selection.rowId || area !== selection.area) {
      next = moveComposerItem(next, selected, rowId, area, selection.index);
    }
    if (patch.display && patch.display !== selection.item.display) {
      next = setComposerItemDisplay(next, selected, patch.display);
    }
    setNotice('');
    commit(next);
  }

  function removeSelected() {
    if (!selected) return;
    if (REQUIRED.includes(selected)) {
      setNotice('Menu and Send always stay in the tray.');
      return;
    }
    commit(removeComposerItem(layout, selected));
    setSelected(null);
  }

  const status = activeId
    ? overPalette
      ? `Release to remove ${activeLabel}`
      : `Moving ${activeLabel}`
    : `${layout.rows.length} ${layout.rows.length === 1 ? 'row' : 'rows'}, ${placed.size} controls`;

  return (
    <section
      className="composer-editor"
      aria-label={`Customise ${kind === 'single' ? 'chat' : 'group'} composer`}
    >
      <div className="composer-editor__head">
        <strong>Customise composer</strong>
        <span className="composer-editor__hint">
          Drag a control into the tray. Drop one in a gap to start a row.
        </span>
        <span className="composer-editor__status" role="status" aria-live="polite">
          {status}
        </span>
        <button
          type="button"
          className="wc-button wc-button--ghost composer__icon"
          aria-pressed={paletteOpen}
          aria-expanded={paletteOpen}
          title={paletteOpen ? 'Hide the control palette' : 'Show the control palette'}
          onClick={() => setPaletteOpen((open) => !open)}
        >
          <GridIcon />
        </button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={finishDrag}
      >
        {paletteOpen ? (
          <div
            ref={paletteRef}
            className="composer-editor__palette"
            data-over={overPalette || undefined}
          >
            <div className="composer-editor__palette-head">
              <span>Controls</span>
              <span className="composer-editor__palette-hint">
                {overPalette
                  ? 'Release to remove'
                  : 'Drag down to add. Drag a placed control up here to remove it.'}
              </span>
            </div>
            <div className="composer-editor__search">
              <SearchIcon />
              <input
                className="wc-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a control…"
                aria-label="Find a composer control"
              />
            </div>
            <div className="composer-editor__palette-grid">
              {available.map((control) => (
                <PaletteItem
                  key={control.id}
                  control={control}
                  reducedMotion={reducedMotion}
                  onAdd={() => addControl(control.id)}
                >
                  {renderControl({ id: control.id, display: 'icon' })}
                </PaletteItem>
              ))}
              {!available.length ? (
                <span className="wc-hint composer-editor__palette-empty">
                  {placed.size
                    ? 'Every control is placed. Drag one up here to make room.'
                    : 'No control matches that search.'}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="composer-editor__canvas">
          {layout.rows.map((row, rowIndex) => (
            <Fragment key={row.id}>
              {rowIndex > 0 ? <RowDivider index={rowIndex} canAdd={canAddRow} /> : null}
              <div className="composer-editor__row" data-row={rowIndex}>
                {COMPOSER_AREAS.map((area) => (
                  <DroppableArea
                    key={area}
                    rowId={row.id}
                    area={area}
                    itemIds={row[area].map((item) => item.id)}
                  >
                    {row[area].map((item) => (
                      <SortableChip
                        key={item.id}
                        item={item}
                        label={byId.get(item.id)?.label ?? item.id}
                        selected={selected === item.id}
                        reducedMotion={reducedMotion}
                        onSelect={() => {
                          if (justDragged.current) return;
                          setSelected(item.id);
                          setNotice('');
                        }}
                      >
                        {renderControl(item)}
                      </SortableChip>
                    ))}
                  </DroppableArea>
                ))}
              </div>
            </Fragment>
          ))}
          <RowDivider index={layout.rows.length} canAdd={canAddRow} />
        </div>
      </DndContext>

      <div className="composer-editor__selection">
        {selection && selected ? (
          <>
            <strong>{byId.get(selected)?.label ?? selected}</strong>
            <label>
              Row{' '}
              <select
                value={selection.rowId}
                onChange={(event) => updateSelected({ rowId: event.target.value })}
              >
                {layout.rows.map((row, index) => (
                  <option value={row.id} key={row.id}>
                    {index + 1}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              disabled={!canAddRow}
              title={canAddRow ? 'Move to a new row' : `At most ${MAX_COMPOSER_ROWS} rows.`}
              onClick={() => moveToNewRow(selected)}
            >
              <PlusIcon />
              New row
            </button>
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
              disabled={REQUIRED.includes(selected)}
              title={
                REQUIRED.includes(selected) ? 'This control always stays in the tray.' : 'Remove'
              }
              onClick={removeSelected}
            >
              <TrashIcon />
              Remove
            </button>
          </>
        ) : (
          <span className="wc-hint">Select a control for row, alignment and style options.</span>
        )}
      </div>

      <div className="composer-editor__footer">
        {notice ? (
          <span className="composer-editor__notice" role="status">
            {notice}
          </span>
        ) : null}
        <span className="composer-editor__footer-spacer" />
        <button type="button" className="wc-button wc-button--ghost" onClick={onReset}>
          Reset layout
        </button>
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
