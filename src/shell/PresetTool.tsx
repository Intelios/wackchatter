/**
 * The Preset tool: the prompts and the generation settings in one place.
 *
 * What's sent (the prompt order) comes first, since prompt text is what gets changed most;
 * how it's sent (the chat model, samplers, context, wording) sits below it. A bar above
 * the prompts shows how the request divides up. Presets save when you say so: every
 * change since the last save carries a dot that puts it back, and a pill counts them.
 * Opening a prompt widens the margin (the shell's `data-wide`), the list becoming a rail.
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
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
import { REASONING_EFFORT_OPTIONS, withReasoningEffort } from '@shared/models/reasoning.ts';
import type { ModelRef } from '@shared/models/slots.ts';
import { DEFAULT_IMPERSONATION_PROMPT } from '@shared/prompt/defaults.ts';
import {
  addCustomPrompt,
  addDocumentationPrompt,
  deleteCustomPrompt,
  getPromptById,
  getPromptOrder,
  setPromptOrder,
  updatePrompt,
} from '@shared/prompt/preset-io.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import {
  claudeReplyTokens,
  claudeThinkingBudget,
  isAnthropicModel,
} from '@shared/providers/request.ts';
import { isResponseUnlimited, responseCap } from '@shared/providers/responseLength.ts';
import type { Connection, ResolvedModel } from '@shared/providers/types.ts';
import type { MacroWarning } from '@shared/types/chat.ts';
import {
  CHARACTER_NAMES_BEHAVIOR,
  DEFAULT_INJECTION_DEPTH,
  DEFAULT_INJECTION_ORDER,
  type GenerationType,
  INJECTION_POSITION,
  type InjectionPosition,
  isBuiltinIdentifier,
  isMarkerIdentifier,
  OVERRIDABLE_IDENTIFIERS,
  type Preset,
  type Prompt,
  type PromptOrderEntry,
  type PromptRole,
  type ReasoningEffort,
} from '@shared/types/preset.ts';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { NumberField, SelectField, TextField } from '../components/Field.tsx';
import { Select } from '../components/Select.tsx';
import { Slider } from '../components/Slider.tsx';
import { ModelPicker } from '../features/models/ModelPicker.tsx';
import type { PresetDraft } from '../features/preset/usePresetDraft.ts';
import { presetApi } from '../lib/api.ts';
import { Icon } from './icons.tsx';
import { depthWords } from './personas.ts';
import {
  type ContextSegment,
  contextSegments,
  presetChanges,
  revertField,
  revertOrder,
  revertPrompt,
  segmentKind,
} from './preset.ts';
import './preset.css';
import './sheet.css';

/** Not a protocol limit: a guard on a field where a stray keystroke is a real bill. */
const MAX_COMPLETIONS = 8;

export interface PresetToolProps {
  preset: Preset | null;
  draft: PresetDraft;
  presetCount: number;
  presetId: string | null;
  /** Token count per prompt identifier from the open chat's preview, when there is one. */
  tokenCounts: Record<string, number> | undefined;
  macroWarnings: MacroWarning[];
  countTokens: TokenCounter;
  /** The prompt open in the editor, or null. */
  open: string | null;
  setOpen: (identifier: string | null) => void;
  chatModel: ModelRef | null;
  chatReasoningEffort?: ReasoningEffort;
  chatModelDisabledReason?: string;
  onChatModel: (ref: ModelRef | null) => void;
  connection: ResolvedModel | null;
  extraSamplersSent: boolean;
  onConnectionPatch: (patch: Partial<Connection>) => void;
  /** Leaves for the Preset Co-Creator's sessions. */
  onOpenCoCreator?: () => void;
}

export function PresetTool(props: PresetToolProps) {
  const { preset, draft, open, setOpen } = props;
  const [hot, setHot] = useState<string | null>(null);
  const changes = useMemo(() => presetChanges(draft.saved, preset), [draft.saved, preset]);

  if (!preset) return <p className="w3-sheet__hint">Loading presets…</p>;

  const saved = draft.saved;
  const changedPrompts = new Set(changes.prompts);
  const changedFields = new Set(changes.fields);
  const putBackPrompt = (id: string) => saved && draft.change(revertPrompt(preset, saved, id));
  const putBackField = (key: string) => saved && draft.change(revertField(preset, saved, key));

  const tokensOf = (prompt: Prompt | undefined, identifier: string) => {
    const counted = props.tokenCounts?.[identifier];
    if (counted !== undefined) return counted;
    if (!prompt || isMarkerIdentifier(identifier) || prompt.role === 'documentation') return 0;
    return props.countTokens.countText(prompt.content ?? '');
  };
  const editing = open ? getPromptById(preset, open) : undefined;

  return (
    <div className="w3-preset" data-editing={editing ? '' : undefined}>
      <PresetActions
        draft={draft}
        presetId={props.presetId}
        presetCount={props.presetCount}
        changeCount={changes.count}
        reordered={changes.reordered}
        onRevertOrder={() => saved && draft.change(revertOrder(preset, saved))}
      />

      {props.macroWarnings.length ? (
        <details className="w3-preset__warnings">
          <summary>
            {props.macroWarnings.length} unresolved{' '}
            {props.macroWarnings.length === 1 ? 'macro' : 'macros'}
          </summary>
          <ul>
            {props.macroWarnings.map((warning) => (
              <li key={`${warning.source}:${warning.macro}`}>
                <code>{warning.macro}</code> in {warning.source}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editing ? (
        <div className="w3-preset__split">
          <PromptList
            preset={preset}
            onChange={draft.change}
            open={open}
            onOpen={(id) => setOpen(id === open ? null : id)}
            changed={changedPrompts}
            onPutBack={putBackPrompt}
            tokensOf={tokensOf}
            hot={hot}
            onHot={setHot}
            rail
          />
          <PromptEditor
            key={editing.identifier}
            preset={preset}
            prompt={editing}
            tokens={tokensOf(editing, editing.identifier)}
            changed={changedPrompts.has(editing.identifier)}
            onPutBack={() => putBackPrompt(editing.identifier)}
            onChange={draft.change}
            onClose={() => setOpen(null)}
          />
        </div>
      ) : (
        <>
          <ContextBar
            segments={contextSegments(preset, tokensOf)}
            limit={preset.openai_max_context ?? 4095}
            counted={Boolean(props.tokenCounts)}
            hot={hot}
            onHot={setHot}
          />
          <section className="w3-preset__group" aria-label="What's sent">
            <h3 className="w3-sheet__label">
              What's sent
              <small>
                {getPromptOrder(preset).filter((e) => e.enabled && !isDocs(preset, e)).length} of{' '}
                {getPromptOrder(preset).filter((e) => !isDocs(preset, e)).length} on
              </small>
            </h3>
            <PromptList
              preset={preset}
              onChange={draft.change}
              open={open}
              onOpen={setOpen}
              changed={changedPrompts}
              onPutBack={putBackPrompt}
              tokensOf={tokensOf}
              hot={hot}
              onHot={setHot}
            />
            <div className="w3-preset__adds">
              <button
                type="button"
                className="w3-preset__ghost"
                onClick={() => {
                  const created = addCustomPrompt(preset);
                  draft.change(created.preset);
                  setOpen(created.identifier);
                }}
              >
                <Icon name="plus" size="xs" />
                Prompt
              </button>
              <button
                type="button"
                className="w3-preset__ghost"
                title="Notes for you and the Preset Co-Creator. Never sent."
                onClick={() => {
                  const created = addDocumentationPrompt(preset);
                  draft.change(created.preset);
                  setOpen(created.identifier);
                }}
              >
                <Icon name="plus" size="xs" />
                Documentation
              </button>
              {props.onOpenCoCreator ? (
                <button
                  type="button"
                  className="w3-preset__ghost w3-preset__cc"
                  title="Work on presets with the Preset Co-Creator"
                  onClick={props.onOpenCoCreator}
                >
                  <Icon name="sparkles" size="xs" />
                  Open in Preset Co-Creator
                </button>
              ) : null}
            </div>
          </section>
          <HowItsSent {...props} preset={preset} changed={changedFields} onPutBack={putBackField} />
        </>
      )}
    </div>
  );
}

function isDocs(preset: Preset, entry: PromptOrderEntry): boolean {
  return getPromptById(preset, entry.identifier)?.role === 'documentation';
}

/** A change since the last save. Clicking it puts that one thing back. */
function ChangeDot({ label, onPutBack }: { label: string; onPutBack: () => void }) {
  return (
    <button
      type="button"
      className="w3-dot"
      onClick={onPutBack}
      title={`Changed since the last save. Click to put ${label} back.`}
      aria-label={`Put ${label} back`}
    />
  );
}

// ---------------------------------------------------------------------------
// The preset: its name (the margin's heading), actions and save state

function PresetActions({
  draft,
  presetId,
  presetCount,
  changeCount,
  reordered,
  onRevertOrder,
}: {
  draft: PresetDraft;
  presetId: string | null;
  presetCount: number;
  changeCount: number;
  reordered: boolean;
  onRevertOrder: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteBlocked = !presetId
    ? 'No preset selected.'
    : draft.dirty
      ? 'Save or revert your changes before deleting.'
      : presetCount <= 1
        ? 'The last preset cannot be deleted. Duplicate or import another first.'
        : null;

  if (draft.renaming) {
    return (
      <div className="w3-preset__bar">
        <input
          className="w3-preset__rename"
          // biome-ignore lint/a11y/noAutofocus: the field only exists once Rename is clicked
          autoFocus
          aria-label="Preset name"
          value={draft.nameDraft}
          onChange={(event) => draft.setNameDraft(event.target.value)}
          onBlur={() => void draft.rename(draft.nameDraft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              event.preventDefault();
              draft.cancelRename();
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="w3-preset__bar">
      <button
        type="button"
        className="w3-preset__icon"
        title={draft.dirty ? 'Save or revert your changes before renaming.' : 'Rename preset'}
        aria-label="Rename preset"
        disabled={draft.dirty || !presetId}
        onClick={draft.startRename}
      >
        <Icon name="pencil" size="sm" />
      </button>
      <button
        type="button"
        className="w3-preset__icon"
        title="Duplicate preset"
        aria-label="Duplicate preset"
        disabled={!presetId}
        onClick={() => void draft.duplicate()}
      >
        <Icon name="copy" size="sm" />
      </button>
      <button
        type="button"
        className="w3-preset__icon"
        title={draft.dirty ? 'Save or revert your changes before importing.' : 'Import a preset'}
        aria-label="Import a preset"
        disabled={draft.dirty}
        onClick={() => fileInput.current?.click()}
      >
        <Icon name="upload" size="sm" />
      </button>
      <a
        className="w3-preset__icon"
        title="Export preset"
        aria-label="Export preset"
        href={presetId ? presetApi.exportUrl(presetId) : undefined}
        download
      >
        <Icon name="download" size="sm" />
      </a>
      <button
        type="button"
        className="w3-preset__icon"
        data-armed={confirmDelete || undefined}
        title={confirmDelete ? 'Click again to delete' : (deleteBlocked ?? 'Delete preset')}
        aria-label={confirmDelete ? 'Click again to delete the preset' : 'Delete preset'}
        disabled={deleteBlocked !== null}
        onClick={() => {
          if (!confirmDelete) return setConfirmDelete(true);
          setConfirmDelete(false);
          void draft.remove();
        }}
        onBlur={() => setConfirmDelete(false)}
      >
        <Icon name="trash" size="sm" />
        {confirmDelete ? <span>Click again</span> : null}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".json"
        className="wc-visually-hidden"
        onChange={(event) => {
          void draft.importPreset(event.target.files?.[0]);
          event.target.value = '';
        }}
      />

      {draft.dirty && changeCount ? (
        <output className="w3-preset__save">
          <span>
            {changeCount} {changeCount === 1 ? 'change' : 'changes'}
          </span>
          {reordered ? (
            <button type="button" onClick={onRevertOrder} title="Put the order back as saved">
              Order
            </button>
          ) : null}
          <button type="button" onClick={draft.revert}>
            Revert
          </button>
          <button type="button" className="w3-preset__go" onClick={() => void draft.save()}>
            Save
          </button>
        </output>
      ) : (
        <span className="w3-preset__status">{draft.status || 'Saved'}</span>
      )}
    </div>
  );
}

/** The margin's heading on the Preset tool: the preset's name, which switches presets. */
export function PresetSwitcher({
  name,
  presets,
  presetId,
  dirty,
  onSelect,
}: {
  name: string;
  presets: { id: string; name: string }[];
  presetId: string | null;
  dirty: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <Select
      className="w3-preset__switch"
      label="Preset"
      value={presetId ?? ''}
      options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
      onChange={onSelect}
      disabled={dirty}
      disabledReason={`${name}: save or revert your changes before switching presets.`}
    />
  );
}

// ---------------------------------------------------------------------------
// The context bar

function ContextBar({
  segments,
  limit,
  counted,
  hot,
  onHot,
}: {
  segments: ContextSegment[];
  limit: number;
  counted: boolean;
  hot: string | null;
  onHot: (id: string | null) => void;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const kinds = (['mine', 'card', 'lore', 'history'] as const).filter((kind) =>
    segments.some((segment) => segment.kind === kind),
  );
  const KIND_LABEL = {
    mine: 'Your prompts',
    card: 'Card & persona',
    lore: 'Lore',
    history: 'Chat history',
  };
  return (
    <div className="w3-ctx">
      <div className="w3-ctx__top">
        <span>
          <b>{total.toLocaleString()}</b> tokens sent
        </span>
        <span>
          {counted
            ? `limit ${limit.toLocaleString()}`
            : 'Open a chat to count the card and history'}
        </span>
      </div>
      <div className="w3-ctx__bar" data-hover={hot ? '' : undefined}>
        {segments.map((segment) => (
          <span
            key={segment.identifier}
            className="w3-ctx__seg"
            data-kind={segment.kind}
            data-hot={hot === segment.identifier || undefined}
            style={{ flexGrow: segment.tokens }}
            title={`${segment.name} · ${segment.tokens.toLocaleString()} tokens`}
            onPointerEnter={() => onHot(segment.identifier)}
            onPointerLeave={() => onHot(null)}
          />
        ))}
      </div>
      {kinds.length ? (
        <div className="w3-ctx__key">
          {kinds.map((kind) => (
            <span key={kind}>
              <i data-kind={kind} />
              {KIND_LABEL[kind]}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What's sent: the prompt order

function PromptList({
  preset,
  onChange,
  open,
  onOpen,
  changed,
  onPutBack,
  tokensOf,
  hot,
  onHot,
  rail = false,
}: {
  preset: Preset;
  onChange: (preset: Preset) => void;
  open: string | null;
  onOpen: (identifier: string) => void;
  changed: ReadonlySet<string>;
  onPutBack: (identifier: string) => void;
  tokensOf: (prompt: Prompt | undefined, identifier: string) => number;
  hot: string | null;
  onHot: (id: string | null) => void;
  rail?: boolean;
}) {
  const order = getPromptOrder(preset);
  const prompts = new Map((preset.prompts ?? []).map((p) => [p.identifier, p]));
  const sensors = useSensors(
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

  function toggle(identifier: string) {
    if (prompts.get(identifier)?.role === 'documentation') return;
    onChange(
      setPromptOrder(
        preset,
        order.map((e) => (e.identifier === identifier ? { ...e, enabled: !e.enabled } : e)),
      ),
    );
  }

  return (
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
        <ul className="w3-prompts" data-rail={rail || undefined}>
          {order.map((entry) => {
            const prompt = prompts.get(entry.identifier);
            return (
              <PromptRow
                key={entry.identifier}
                entry={entry}
                prompt={prompt}
                tokens={tokensOf(prompt, entry.identifier)}
                open={open === entry.identifier}
                changed={changed.has(entry.identifier)}
                hot={hot === entry.identifier}
                onHot={onHot}
                onToggle={() => toggle(entry.identifier)}
                onOpen={() => onOpen(entry.identifier)}
                onPutBack={() => onPutBack(entry.identifier)}
              />
            );
          })}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function PromptRow({
  entry,
  prompt,
  tokens,
  open,
  changed,
  hot,
  onHot,
  onToggle,
  onOpen,
  onPutBack,
}: {
  entry: PromptOrderEntry;
  prompt: Prompt | undefined;
  tokens: number;
  open: boolean;
  changed: boolean;
  hot: boolean;
  onHot: (id: string | null) => void;
  onToggle: () => void;
  onOpen: () => void;
  onPutBack: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.identifier,
  });
  const name = prompt?.name ?? entry.identifier;
  const isMarker = isMarkerIdentifier(entry.identifier);
  const isDocumentation = prompt?.role === 'documentation';
  const isAbsolute = !isDocumentation && prompt?.injection_position === INJECTION_POSITION.ABSOLUTE;
  const sent = entry.enabled && !isDocumentation && tokens > 0;

  return (
    <li
      ref={setNodeRef}
      className="w3-prompt"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-dragging={isDragging || undefined}
      data-off={!entry.enabled || undefined}
      data-open={open || undefined}
      data-hot={hot || undefined}
      onPointerEnter={() => onHot(entry.identifier)}
      onPointerLeave={() => onHot(null)}
    >
      {changed ? <ChangeDot label={name} onPutBack={onPutBack} /> : null}
      <button
        type="button"
        className="w3-prompt__grip"
        aria-label={`Move ${name}`}
        {...attributes}
        {...listeners}
      >
        <svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true" fill="currentColor">
          <circle cx="2" cy="3" r="1.3" />
          <circle cx="8" cy="3" r="1.3" />
          <circle cx="2" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="2" cy="13" r="1.3" />
          <circle cx="8" cy="13" r="1.3" />
        </svg>
      </button>
      <button
        type="button"
        role="switch"
        className="w3-switch"
        aria-checked={entry.enabled}
        aria-label={`Send ${name}`}
        disabled={isDocumentation}
        title={isDocumentation ? 'Documentation is never sent.' : undefined}
        onClick={onToggle}
      />
      <button type="button" className="w3-prompt__main" onClick={onOpen} aria-expanded={open}>
        <b>{name}</b>
        {isMarker ? <span className="w3-tag">marker</span> : null}
        {isDocumentation ? (
          <span className="w3-tag" data-doc>
            documentation
          </span>
        ) : null}
        {isAbsolute ? (
          <span className="w3-tag">@{prompt?.injection_depth ?? DEFAULT_INJECTION_DEPTH}</span>
        ) : null}
        {prompt?.role && prompt.role !== 'system' && !isDocumentation ? (
          <span className="w3-tag">{prompt.role}</span>
        ) : null}
      </button>
      <span className="w3-prompt__tokens">
        {isDocumentation ? '–' : tokens ? tokens.toLocaleString() : ''}
      </span>
      <span
        className="w3-prompt__seg"
        data-kind={sent ? segmentKind(entry.identifier) : undefined}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// The prompt editor

const TRIGGERS: Array<{ value: GenerationType; label: string; unavailable?: boolean }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'continue', label: 'Continue' },
  { value: 'swipe', label: 'Swipe' },
  { value: 'regenerate', label: 'Regenerate' },
  { value: 'impersonate', label: 'Impersonate' },
  { value: 'quiet', label: 'Quiet', unavailable: true },
];

const MESSAGE_ROLES: PromptRole[] = ['system', 'user', 'assistant'];

const MARKER_SOURCES: Record<string, string> = {
  chatHistory: 'the chat’s messages, newest kept first',
  worldInfoBefore: 'lore that fires before the card',
  worldInfoAfter: 'lore that fires after the card',
  charDescription: 'the character card’s description',
  charPersonality: 'the character card’s personality',
  scenario: 'the character card’s scenario',
  personaDescription: 'your persona’s description',
  dialogueExamples: 'the character card’s example dialogue',
};

function PromptEditor({
  preset,
  prompt,
  tokens,
  changed,
  onPutBack,
  onChange,
  onClose,
}: {
  preset: Preset;
  prompt: Prompt;
  tokens: number;
  changed: boolean;
  onPutBack: () => void;
  onChange: (preset: Preset) => void;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const id = prompt.identifier;
  const isMarker = isMarkerIdentifier(id);
  const isDocumentation = prompt.role === 'documentation';
  const isAbsolute = prompt.injection_position === INJECTION_POSITION.ABSOLUTE;
  const set = (changes: Partial<Prompt>) => onChange(updatePrompt(preset, id, changes));
  const triggers = prompt.injection_trigger ?? [];

  const word = <T,>(
    label: string,
    value: T,
    options: readonly { value: T; label: string }[],
    onPick: (value: T) => void,
  ) => (
    <Select
      className="w3-word"
      label={label}
      value={value}
      options={options}
      onChange={onPick}
      searchable={false}
    />
  );

  const roles = (isMarker ? MESSAGE_ROLES : [...MESSAGE_ROLES, 'documentation' as const]).map(
    (role) => ({ value: role, label: role === 'documentation' ? 'documentation' : role }),
  );
  const depth = prompt.injection_depth ?? DEFAULT_INJECTION_DEPTH;
  const depthOptions = Array.from({ length: Math.max(21, depth + 1) }, (_, value) => ({
    value,
    label: depthWords(value),
  }));

  return (
    <div className="w3-pe">
      <div className="w3-pe__top">
        {prompt.system_prompt ? (
          <h3 className="w3-pe__title">{prompt.name}</h3>
        ) : (
          <input
            className="w3-pe__name"
            value={prompt.name}
            aria-label="Prompt name"
            onChange={(event) => set({ name: event.target.value })}
          />
        )}
        <button type="button" className="w3-margin__close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size="sm" />
        </button>
      </div>

      <p className="w3-pe__how">
        {isDocumentation ? (
          <>
            Kept as{' '}
            {word('Role', prompt.role ?? 'system', roles, (role: PromptRole) => set({ role }))}:
            notes for you and the Preset Co-Creator, never sent.
          </>
        ) : (
          <>
            Sent as a{' '}
            {word('Role', prompt.role ?? 'system', roles, (role: PromptRole) => set({ role }))}{' '}
            message,{' '}
            {word(
              'Position',
              (isAbsolute
                ? INJECTION_POSITION.ABSOLUTE
                : INJECTION_POSITION.RELATIVE) as InjectionPosition,
              [
                { value: INJECTION_POSITION.RELATIVE, label: 'in its place in the list' },
                { value: INJECTION_POSITION.ABSOLUTE, label: 'into the chat' },
              ],
              (position: InjectionPosition) => set({ injection_position: position }),
            )}
            {isAbsolute ? (
              <>
                ,{' '}
                {word('Depth', depth, depthOptions, (value: number) =>
                  set({ injection_depth: value }),
                )}
                , order{' '}
                <input
                  className="w3-pe__order"
                  type="number"
                  value={prompt.injection_order ?? DEFAULT_INJECTION_ORDER}
                  aria-label="Order at the same depth"
                  title="Higher goes first at the same depth"
                  onChange={(event) => set({ injection_order: Number(event.target.value) })}
                />
              </>
            ) : null}
            .
          </>
        )}
      </p>

      {isMarker ? (
        <p className="w3-pe__marker">
          A marker: filled in when the request is made, from {MARKER_SOURCES[id] ?? 'the chat'}. Its
          role and place are yours to change; the text is not.
        </p>
      ) : (
        <div className="w3-pe__text">
          <TextField
            label={isDocumentation ? 'Notes' : 'Text'}
            value={prompt.content ?? ''}
            onChange={(content) => set({ content })}
            multiline
            rows={18}
            macros={!isDocumentation}
            hint={
              isDocumentation
                ? 'Plain text or Markdown for people reading the preset.'
                : 'Type {{ for the macro list.'
            }
          />
        </div>
      )}

      {!isDocumentation ? (
        <div className="w3-pe__triggers">
          <span>Only on</span>
          {TRIGGERS.map((trigger) => {
            const on = triggers.includes(trigger.value);
            return (
              <button
                key={trigger.value}
                type="button"
                className="w3-chip"
                aria-pressed={on}
                title={
                  trigger.unavailable
                    ? 'Kept for SillyTavern; this kind of reply is not in the app yet.'
                    : undefined
                }
                onClick={() =>
                  set({
                    injection_trigger: on
                      ? triggers.filter((t) => t !== trigger.value)
                      : [...triggers, trigger.value],
                  })
                }
              >
                {trigger.label}
              </button>
            );
          })}
          <small>{triggers.length ? '' : 'Nothing picked: sent on every reply.'}</small>
        </div>
      ) : null}

      {(OVERRIDABLE_IDENTIFIERS as readonly string[]).includes(id) && !isDocumentation ? (
        <label className="w3-pe__check">
          <button
            type="button"
            role="switch"
            className="w3-switch"
            aria-checked={Boolean(prompt.forbid_overrides)}
            onClick={() => set({ forbid_overrides: !prompt.forbid_overrides })}
          />
          <span>
            Keep this over the card’s own{' '}
            {id === 'main' ? 'system prompt' : 'post-history instructions'}
          </span>
        </label>
      ) : null}

      <div className="w3-pe__foot">
        <span>
          <b>{isDocumentation ? 0 : tokens.toLocaleString()}</b> tokens
        </span>
        {changed ? (
          <button type="button" className="w3-pe__putback" onClick={onPutBack}>
            <i />
            Changed · put back
          </button>
        ) : null}
        {!isBuiltinIdentifier(id) ? (
          <button
            type="button"
            className="w3-preset__ghost"
            data-armed={confirmDelete || undefined}
            onClick={() => {
              if (!confirmDelete) return setConfirmDelete(true);
              onClose();
              onChange(deleteCustomPrompt(preset, id));
            }}
            onBlur={() => setConfirmDelete(false)}
          >
            <Icon name="trash" size="xs" />
            {confirmDelete ? 'Click again to delete' : 'Delete'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// How it's sent

function Fold({
  title,
  meta,
  changes,
  children,
}: {
  title: string;
  meta?: string;
  changes: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w3-hfold" data-open={open || undefined}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevronDown" size="xs" />
        {title}
        {changes ? <i className="w3-hfold__dot" title={`${changes} changed`} /> : null}
        {meta ? <small>{meta}</small> : null}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

function HowItsSent({
  preset,
  draft,
  changed,
  onPutBack,
  chatModel,
  chatReasoningEffort,
  chatModelDisabledReason,
  onChatModel,
  connection,
  extraSamplersSent,
  onConnectionPatch,
}: PresetToolProps & {
  preset: Preset;
  changed: ReadonlySet<string>;
  onPutBack: (key: string) => void;
}) {
  const setField = draft.setField;
  const unlimited = isResponseUnlimited(preset);
  const responseTokens = claudeReplyTokens(responseCap(preset));
  const claudeOnOpenRouter =
    connection?.provider === 'openrouter' && isAnthropicModel(connection.model);
  const claudeBudget = claudeOnOpenRouter
    ? claudeThinkingBudget(
        responseTokens,
        withReasoningEffort(preset, chatReasoningEffort),
        preset.stream_openai !== false,
      )
    : null;
  const chatEffortLabel = REASONING_EFFORT_OPTIONS.find(([id]) => id === chatReasoningEffort)?.[1];
  const extraOnly = extraSamplersSent ? undefined : 'Not sent by this provider (OpenRouter only)';

  /** One setting with its change dot. */
  const row = (key: string | number, label: string, control: ReactNode, off?: string) => (
    <div className="w3-hrow" data-off={off ? '' : undefined} title={off}>
      {changed.has(String(key)) ? (
        <ChangeDot label={label} onPutBack={() => onPutBack(String(key))} />
      ) : null}
      {control}
    </div>
  );
  const slider = (
    key: keyof Preset,
    label: string,
    fallback: number,
    min: number,
    max: number,
    step: number,
    off?: string,
  ) =>
    row(
      key,
      label,
      <Slider
        label={label}
        value={(preset[key] as number | undefined) ?? fallback}
        min={min}
        max={max}
        step={step}
        onChange={(value) => setField(key, step >= 1 ? Math.round(value) : value)}
      />,
      off,
    );
  const toggle = (key: keyof Preset, label: string, on: boolean, hint?: string) =>
    row(
      key,
      label,
      <label className="w3-htoggle">
        <span>
          {label}
          {hint ? <small>{hint}</small> : null}
        </span>
        <button
          type="button"
          role="switch"
          className="w3-switch"
          aria-checked={on}
          onClick={() => setField(key, !on)}
        />
      </label>,
    );
  const text = (
    key: keyof Preset,
    label: string,
    fallback: string,
    multiline = false,
    hint?: string,
  ) =>
    row(
      key,
      label,
      <TextField
        label={label}
        value={(preset[key] as string | undefined) ?? fallback}
        onChange={(value) => setField(key, value)}
        multiline={multiline}
        hint={hint}
      />,
    );
  const count = (keys: string[]) => keys.filter((key) => changed.has(key)).length;

  return (
    <section className="w3-preset__group" aria-label="How it's sent">
      <h3 className="w3-sheet__label">How it's sent</h3>
      <div className="w3-hmodel">
        <ModelPicker
          label="Chat model"
          value={chatModel}
          onChange={onChatModel}
          disabled={Boolean(chatModelDisabledReason)}
          disabledReason={chatModelDisabledReason}
        />
        <small>
          Connections are set up in Settings. Replies, recaps and impersonation use this model.
        </small>
      </div>

      <div className="w3-hrows">
        {slider('temperature', 'Temperature', 1, 0, 2, 0.01)}
        {slider('top_p', 'Top P', 1, 0, 1, 0.01)}
        {slider('top_k', 'Top K', 0, 0, 200, 1, extraOnly)}
        {slider('top_a', 'Top A', 0, 0, 1, 0.01, extraOnly)}
        {slider('min_p', 'Min P', 0, 0, 1, 0.01, extraOnly)}
        {slider('frequency_penalty', 'Frequency penalty', 0, -2, 2, 0.01)}
        {slider('presence_penalty', 'Presence penalty', 0, -2, 2, 0.01)}
        {slider('repetition_penalty', 'Repetition penalty', 1, 0, 2, 0.01, extraOnly)}
        <p className="w3-sheet__hint">
          At its neutral value (0, or 1 for repetition penalty) a sampler is left out of the
          request.
        </p>
        {row(
          'reasoning_effort',
          'Reasoning effort',
          <SelectField<ReasoningEffort>
            label="Reasoning effort"
            value={preset.reasoning_effort ?? 'auto'}
            options={REASONING_EFFORT_OPTIONS.map(([value, label]) => ({ value, label }))}
            onChange={(value) => setField('reasoning_effort', value)}
            hint="Preset default. Only reasoning models use this. Auto sends nothing."
          />,
        )}
        {chatEffortLabel ? (
          <p className="w3-sheet__hint">
            Chat uses {chatEffortLabel}, remembered for the selected model. Choose Use preset in the
            island’s model picker to follow this default.
          </p>
        ) : null}
        {claudeOnOpenRouter ? (
          <p className="w3-sheet__hint">
            {claudeBudget === null
              ? 'Claude on OpenRouter thinks only when an effort is set; on Auto it does not think at all.'
              : `Claude on OpenRouter gets a ${claudeBudget.toLocaleString()}-token thinking budget on top of the ${responseTokens.toLocaleString()}-token reply. Temperature, Top P and Top K are not sent while it thinks.`}
          </p>
        ) : null}
      </div>

      <h3 className="w3-sheet__label">Context</h3>
      <div className="w3-hrows">
        {slider('openai_max_context', 'Max context', 4095, 512, 1000000, 1)}
        {unlimited ? null : slider('openai_max_tokens', 'Max response', 300, 16, 16384, 1)}
        {toggle(
          'openai_max_tokens_unlimited',
          'No reply limit',
          unlimited,
          'Replies run until the model finishes.',
        )}
        {toggle(
          'stream_openai',
          'Endpoint can stream',
          preset.stream_openai !== false,
          'Turn off only for an endpoint that can’t stream. To read replies whole, turn Streaming off in Settings ▸ Look.',
        )}
        {toggle(
          'squash_system_messages',
          'Squash system messages',
          Boolean(preset.squash_system_messages),
          'Merge system messages that sit together.',
        )}
      </div>

      {connection ? (
        <>
          <h3 className="w3-sheet__label">
            {connection.name}
            <small>saved at once, not with the preset</small>
          </h3>
          <div className="w3-hrows">
            <label className="w3-htoggle">
              <span>Show reasoning</span>
              <button
                type="button"
                role="switch"
                className="w3-switch"
                aria-checked={connection.showReasoning !== false}
                onClick={() =>
                  onConnectionPatch({ showReasoning: connection.showReasoning === false })
                }
              />
            </label>
            <label className="w3-htoggle">
              <span>
                Report real token usage
                <small>Some OpenAI-compatible proxies reject it.</small>
              </span>
              <button
                type="button"
                role="switch"
                className="w3-switch"
                aria-checked={Boolean(connection.reportUsage)}
                onClick={() => onConnectionPatch({ reportUsage: !connection.reportUsage })}
              />
            </label>
          </div>
        </>
      ) : null}

      <div className="w3-hfolds">
        <Fold title="More samplers" meta="Seed, completions" changes={count(['seed', 'n'])}>
          {row(
            'seed',
            'Seed',
            <NumberField
              label="Seed"
              value={preset.seed ?? -1}
              min={-1}
              step={1}
              onChange={(value) => setField('seed', Math.round(value))}
              hint="-1 lets the provider choose."
            />,
          )}
          {row(
            'n',
            'Completions',
            <NumberField
              label="Completions"
              value={preset.n ?? 1}
              min={1}
              max={MAX_COMPLETIONS}
              step={1}
              onChange={(value) =>
                setField('n', Math.min(MAX_COMPLETIONS, Math.max(1, Math.round(value))))
              }
              hint="Spares arrive as swipes, and every one is billed."
            />,
          )}
        </Fold>
        <Fold
          title="Formatting"
          meta="Names, lore and markers"
          changes={count([
            'names_behavior',
            'wi_format',
            'personality_format',
            'scenario_format',
            'new_chat_prompt',
            'new_example_chat_prompt',
            'send_if_empty',
          ])}
        >
          {row(
            'names_behavior',
            'Names in prompt',
            <SelectField<number>
              label="Names in prompt"
              value={preset.names_behavior ?? CHARACTER_NAMES_BEHAVIOR.DEFAULT}
              options={[
                { label: 'None', value: CHARACTER_NAMES_BEHAVIOR.NONE },
                { label: 'Default', value: CHARACTER_NAMES_BEHAVIOR.DEFAULT },
                { label: 'Completion name field', value: CHARACTER_NAMES_BEHAVIOR.COMPLETION },
                { label: 'Prefix message content', value: CHARACTER_NAMES_BEHAVIOR.CONTENT },
              ]}
              onChange={(value) => setField('names_behavior', value)}
            />,
          )}
          {text('wi_format', 'World Info format', '{0}', false, 'Use {0} for the lore text.')}
          {text('personality_format', 'Personality format', '{{personality}}')}
          {text('scenario_format', 'Scenario format', '{{scenario}}')}
          {text('new_chat_prompt', 'New chat marker', '[Start a new Chat]', true)}
          {text('new_example_chat_prompt', 'Example dialogue marker', '[Example Chat]')}
          {text(
            'send_if_empty',
            'Send if history ends on assistant',
            '',
            false,
            'Leave empty to send nothing.',
          )}
        </Fold>
        <Fold
          title="Continue"
          meta="Nudge and prefill"
          changes={count(['continue_nudge_prompt', 'continue_prefill', 'continue_postfix'])}
        >
          {text(
            'continue_nudge_prompt',
            'Continue nudge',
            '[Continue your last message without repeating its original content.]',
            true,
          )}
          {toggle(
            'continue_prefill',
            'Use assistant prefill',
            Boolean(preset.continue_prefill),
            'Moves the partial reply to the end instead of adding a nudge.',
          )}
          {text(
            'continue_postfix',
            'Continue postfix',
            ' ',
            false,
            'Between the existing reply and the new text.',
          )}
        </Fold>
        <Fold title="Impersonate" meta="Prompt" changes={count(['impersonation_prompt'])}>
          {text(
            'impersonation_prompt',
            'Impersonation prompt',
            DEFAULT_IMPERSONATION_PROMPT,
            true,
            'Sent last when the model writes your message.',
          )}
        </Fold>
      </div>
    </section>
  );
}
