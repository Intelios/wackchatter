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
import { getPromptOrder, setPromptOrder } from '@shared/prompt/preset-io.ts';
import type { Preset, Prompt, PromptOrderEntry } from '@shared/types/preset.ts';
import { INJECTION_POSITION, isMarkerIdentifier } from '@shared/types/preset.ts';
import { useMemo } from 'react';
import './PromptManager.css';

interface PromptRowProps {
  entry: PromptOrderEntry;
  prompt: Prompt | undefined;
  tokens: number | undefined;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}

function PromptRow({ entry, prompt, tokens, selected, onToggle, onSelect }: PromptRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.identifier,
  });

  const isMarker = isMarkerIdentifier(entry.identifier);
  const isAbsolute = prompt?.injection_position === INJECTION_POSITION.ABSOLUTE;

  return (
    <li
      ref={setNodeRef}
      className="prompt-row"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-dragging={isDragging}
      data-enabled={entry.enabled}
      data-selected={selected}
    >
      <button
        type="button"
        className="prompt-row__grip"
        aria-label={`Reorder ${prompt?.name ?? entry.identifier}`}
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

      <label className="prompt-row__check">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={onToggle}
          aria-label={`Enable ${prompt?.name ?? entry.identifier}`}
        />
      </label>

      <button type="button" className="prompt-row__main" onClick={onSelect}>
        <span className="prompt-row__name">{prompt?.name ?? entry.identifier}</span>
        <span className="prompt-row__tags">
          {isMarker ? <span className="prompt-tag prompt-tag--marker">marker</span> : null}
          {isAbsolute ? (
            <span className="prompt-tag prompt-tag--depth">@{prompt?.injection_depth ?? 4}</span>
          ) : null}
          {prompt?.role && prompt.role !== 'system' ? (
            <span className="prompt-tag">{prompt.role}</span>
          ) : null}
        </span>
      </button>

      <span className="prompt-row__tokens">{tokens != null ? tokens : ''}</span>
    </li>
  );
}

interface PromptManagerProps {
  preset: Preset;
  onChange: (preset: Preset) => void;
  selected: string | null;
  onSelect: (identifier: string | null) => void;
  /** Per-prompt token counts, keyed by identifier. */
  tokenCounts?: Record<string, number>;
}

/**
 * The prompt list: drag to reorder, checkbox to enable.
 *
 * The array order of `prompt_order[].order` IS the list order — there is no separate
 * sort key — so a drop rewrites that array directly, exactly as SillyTavern does.
 */
export function PromptManager({
  preset,
  onChange,
  selected,
  onSelect,
  tokenCounts,
}: PromptManagerProps) {
  const order = useMemo(() => getPromptOrder(preset), [preset]);
  const promptsById = useMemo(() => {
    const map = new Map<string, Prompt>();
    for (const prompt of preset.prompts ?? []) map.set(prompt.identifier, prompt);
    return map;
  }, [preset.prompts]);

  const sensors = useSensors(
    // A small activation distance keeps the checkbox and row click usable.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = order.findIndex((e) => e.identifier === active.id);
    const to = order.findIndex((e) => e.identifier === over.id);
    if (from === -1 || to === -1) return;

    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(setPromptOrder(preset, next));
  }

  function handleToggle(identifier: string) {
    onChange(
      setPromptOrder(
        preset,
        order.map((e) => (e.identifier === identifier ? { ...e, enabled: !e.enabled } : e)),
      ),
    );
  }

  return (
    <div className="prompt-manager">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={order.map((e) => e.identifier)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="prompt-manager__list">
            {order.map((entry) => (
              <PromptRow
                key={entry.identifier}
                entry={entry}
                prompt={promptsById.get(entry.identifier)}
                tokens={tokenCounts?.[entry.identifier]}
                selected={selected === entry.identifier}
                onToggle={() => handleToggle(entry.identifier)}
                onSelect={() => onSelect(selected === entry.identifier ? null : entry.identifier)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}
