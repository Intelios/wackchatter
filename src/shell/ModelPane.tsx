/**
 * Choosing a model, as an island pane: the island opens into the list, the way it opens into
 * your cast or your personas. The same list as every model picker (favourites, recent picks,
 * each connection's catalogue in folding groups, a typed id as a last resort), drawn in the
 * island's own rows.
 */

import { REASONING_EFFORT_OPTIONS } from '@shared/models/reasoning.ts';
import type { ModelRef } from '@shared/models/slots.ts';
import type { ReasoningEffort } from '@shared/types/preset.ts';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useModels } from '../features/models/ModelsContext.tsx';
import {
  describeRef,
  isCurrent,
  type PickerOption,
  type PickerSection,
  pickerSections,
} from '../features/models/pickerLogic.ts';
import { Segments } from './controls.tsx';
import { Icon } from './icons.tsx';

export function ModelPane({
  active,
  value,
  emptyLabel,
  emptyFollows,
  head,
  controls,
  disabledReason,
  onDone,
  onPick,
}: {
  /** The pane is showing: focus the search and fetch the catalogues. */
  active: boolean;
  value: ModelRef | null | undefined;
  /** Offered first when the choice can follow something else. */
  emptyLabel?: string;
  emptyFollows?: ModelRef | null;
  /** Above the search, e.g. what the pick is for. */
  head?: ReactNode;
  controls?: ReactNode;
  disabledReason?: string;
  onDone?: () => void;
  onPick: ((ref: ModelRef | null) => void) | ((ref: ModelRef | null) => Promise<boolean>);
}) {
  const {
    connections,
    recentModels,
    catalogs,
    loadCatalogs,
    rememberModel,
    favoriteModels,
    toggleFavorite,
    pickerGroups,
    setGroupOpen,
  } = useModels();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const wasDisabled = useRef(false);

  useEffect(() => {
    const finishedSaving = wasDisabled.current && !disabledReason;
    wasDisabled.current = Boolean(disabledReason);
    if (!finishedSaving || !active || document.activeElement !== document.body) return;
    const target = lastFocus.current;
    if (target?.isConnected && !target.matches(':disabled')) target.focus({ preventScroll: true });
    else inputRef.current?.focus({ preventScroll: true });
  }, [active, disabledReason]);

  useEffect(() => {
    if (!active) return;
    setQuery('');
    loadCatalogs();
    const timer = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(timer);
  }, [active, loadCatalogs]);

  const sections = useMemo(
    () =>
      active
        ? pickerSections({
            connections,
            recent: recentModels,
            favorites: favoriteModels,
            groups: pickerGroups,
            catalogs,
            query,
          })
        : [],
    [active, connections, recentModels, favoriteModels, pickerGroups, catalogs, query],
  );

  const pick = async (ref: ModelRef | null) => {
    if (disabledReason) return;
    const picked = await onPick(ref);
    if (picked !== false && ref) rememberModel(ref);
  };

  const onKey = (event: KeyboardEvent) => {
    const options = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ??
        []),
    ];
    if (!options.length) return;
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    if (document.activeElement !== inputRef.current && at < 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      options[(at + 1) % options.length]?.focus({ preventScroll: true });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (at <= 0) inputRef.current?.focus({ preventScroll: true });
      else options[at - 1]?.focus({ preventScroll: true });
    } else if (event.key === 'Enter' && document.activeElement === inputRef.current) {
      event.preventDefault();
      options[0]?.click();
    }
  };

  const follows = emptyFollows ? describeRef(emptyFollows, connections, catalogs) : null;

  const option = (entry: PickerOption) => (
    <div key={entry.key} className="w3-mp__row">
      <button
        type="button"
        role="option"
        className="w3-opt"
        aria-selected={isCurrent(entry, value)}
        data-on={isCurrent(entry, value) || undefined}
        tabIndex={-1}
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => void pick(entry.ref)}
      >
        <span className="w3-opt__grow">
          <span className="w3-opt__t">{entry.name}</span>
          <span className="w3-opt__s">
            {entry.hint ? `${entry.hint} · ` : ''}
            {entry.connectionName}
          </span>
        </span>
        {isCurrent(entry, value) ? (
          <span className="w3-opt__ok">
            <Icon name="check" size="sm" />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="w3-mp__star"
        aria-pressed={entry.favorite}
        aria-label={entry.favorite ? `Unstar ${entry.name}` : `Star ${entry.name}`}
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? (entry.favorite ? 'Remove from favourites' : 'Add to favourites')}
        onClick={() => toggleFavorite(entry.ref)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" />
        </svg>
      </button>
    </div>
  );

  const section = (entry: PickerSection, depth = 0): ReactNode => (
    <div key={entry.key} className="w3-mp__sec" data-depth={depth || undefined}>
      {entry.collapsible ? (
        <button
          type="button"
          className="w3-mp__title w3-mp__fold"
          aria-expanded={entry.open}
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onClick={() => setGroupOpen(entry.key, !entry.open)}
        >
          <Icon name="chevronRight" size="xs" />
          {entry.title}
          <span>{entry.count}</span>
        </button>
      ) : (
        <div className="w3-mp__title">{entry.title}</div>
      )}
      {entry.open ? (
        <>
          {entry.note ? <p className="w3-mp__note">{entry.note}</p> : null}
          {entry.options.map(option)}
          {entry.groups?.map((group) => section(group, depth + 1))}
        </>
      ) : null}
    </div>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys walk the options inside
    <div
      className="w3-mp"
      data-controls={controls ? true : undefined}
      onKeyDown={onKey}
      onFocusCapture={(event) => {
        lastFocus.current = event.target as HTMLElement;
      }}
    >
      {head}
      <label className="w3-p-field">
        <Icon name="search" />
        <input
          ref={inputRef}
          value={query}
          placeholder="Search models, or type a model id"
          aria-label="Search models"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="w3-mp__refresh"
          title={disabledReason ?? "Fetch every connection's model list again"}
          disabled={Boolean(disabledReason)}
          aria-label="Fetch the model lists again"
          onClick={() => loadCatalogs(true)}
        >
          <Icon name="refresh" size="sm" />
        </button>
      </label>
      {controls}
      <div className="w3-opt-list w3-mp__list" role="listbox" aria-label="Models" ref={listRef}>
        {emptyLabel && !query.trim() ? (
          <button
            type="button"
            role="option"
            className="w3-opt"
            aria-selected={!value}
            data-on={!value || undefined}
            tabIndex={-1}
            disabled={Boolean(disabledReason)}
            title={disabledReason}
            onClick={() => void pick(null)}
          >
            <span className="w3-opt__grow">
              <span className="w3-opt__t">{emptyLabel}</span>
              {follows ? (
                <span className="w3-opt__s">
                  {follows.name}
                  {follows.connectionName ? ` · ${follows.connectionName}` : ''}
                </span>
              ) : null}
            </span>
            {!value ? (
              <span className="w3-opt__ok">
                <Icon name="check" size="sm" />
              </span>
            ) : null}
          </button>
        ) : null}
        {sections.map((entry) => section(entry))}
        {!connections.length ? (
          <p className="w3-mp__note">Add a connection in Settings first.</p>
        ) : null}
      </div>
      <div className="w3-p-foot">
        <span>{onDone ? '↑ ↓ models, Enter selects' : '↑ ↓ to move, Enter to choose'}</span>
        <span>Esc closes</span>
        {onDone ? (
          <button type="button" className="w3-pill" onClick={onDone}>
            Done
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ModelEffortPane({
  active,
  value,
  effectiveModel = value ?? null,
  emptyLabel,
  emptyFollows,
  head,
  effort,
  fallbackEffort,
  fallbackName = 'preset',
  resetLabel = 'Use preset',
  saving,
  disabledReason,
  pickDisabledReason,
  onPick,
  onEffort,
  onDone,
}: {
  active: boolean;
  value: ModelRef | null | undefined;
  /** Model whose effort is read and written; differs from `value` when following a slot. */
  effectiveModel?: ModelRef | null;
  emptyLabel?: string;
  emptyFollows?: ModelRef | null;
  head?: ReactNode;
  effort: ReasoningEffort | undefined;
  fallbackEffort?: ReasoningEffort;
  fallbackName?: string;
  resetLabel?: string;
  saving: boolean;
  disabledReason: string | null;
  pickDisabledReason?: string | null;
  onPick: ((ref: ModelRef | null) => void) | ((ref: ModelRef | null) => Promise<boolean>);
  onEffort: (effort: ReasoningEffort | null) => void;
  onDone: () => void;
}) {
  const { connections, catalogs } = useModels();
  const current = effectiveModel ? describeRef(effectiveModel, connections, catalogs) : null;
  const effortBlocked = saving
    ? 'Saving model settings…'
    : (disabledReason ?? (!effectiveModel ? 'Choose a model first.' : undefined));
  const paneBlocked = saving ? 'Saving model settings…' : (pickDisabledReason ?? undefined);
  const fallbackLabel =
    fallbackEffort !== undefined
      ? (REASONING_EFFORT_OPTIONS.find(([id]) => id === fallbackEffort)?.[1] ??
        String(fallbackEffort))
      : null;
  const alreadyDefaultTitle =
    fallbackName === 'session default'
      ? 'Already using the session default'
      : `Already using the ${fallbackName} default`;

  return (
    <ModelPane
      active={active}
      value={value}
      emptyLabel={emptyLabel}
      emptyFollows={emptyFollows}
      head={head}
      disabledReason={paneBlocked}
      onPick={onPick}
      onDone={onDone}
      controls={
        <div className="w3-mp__effort">
          <div className="w3-mp__effort-head">
            <span>
              Reasoning effort
              {current ? (
                <span
                  className="w3-mp__effort-model"
                  title={`${current.name} · ${current.connectionName ?? 'deleted connection'}`}
                >
                  · {current.name}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              className="w3-mp__effort-reset"
              disabled={Boolean(effortBlocked) || effort === undefined}
              title={effortBlocked ?? (effort === undefined ? alreadyDefaultTitle : undefined)}
              onClick={() => onEffort(null)}
            >
              {resetLabel}
            </button>
          </div>
          <Segments<ReasoningEffort>
            label="Reasoning effort"
            value={effort}
            options={REASONING_EFFORT_OPTIONS}
            disabled={Boolean(effortBlocked)}
            title={effortBlocked}
            onChange={onEffort}
          />
          <p className="w3-mp__effort-help" aria-live="polite">
            {!effectiveModel
              ? 'Choose a model to set its reasoning effort.'
              : effort === undefined
                ? fallbackLabel
                  ? `Using ${fallbackName}: ${fallbackLabel}. Choose a level to remember it. Only reasoning models use this.`
                  : `Using the ${fallbackName} default. Choose a level to remember it. Only reasoning models use this.`
                : 'Remembered for this model. Auto sends no effort. Only reasoning models use this.'}
          </p>
        </div>
      }
    />
  );
}

export function ChatModelPane({
  active,
  value,
  effort,
  presetEffort,
  saving,
  disabledReason,
  onPick,
  onEffort,
  onDone,
}: {
  active: boolean;
  value: ModelRef | null;
  effort: ReasoningEffort | undefined;
  presetEffort: ReasoningEffort;
  saving: boolean;
  disabledReason: string | null;
  onPick: (ref: ModelRef | null) => Promise<boolean>;
  onEffort: (effort: ReasoningEffort | null) => void;
  onDone: () => void;
}) {
  return (
    <ModelEffortPane
      active={active}
      value={value}
      head={<p className="w3-isl-model__head">The model for your chats</p>}
      effort={effort}
      fallbackEffort={presetEffort}
      fallbackName="preset"
      resetLabel="Use preset"
      saving={saving}
      disabledReason={disabledReason}
      onPick={onPick}
      onEffort={onEffort}
      onDone={onDone}
    />
  );
}
