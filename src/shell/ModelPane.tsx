/**
 * Choosing a model, as an island pane: the island opens into the list, the way it opens into
 * your cast or your personas. The same list as every model picker (favourites, recent picks,
 * each connection's catalogue in folding groups, a typed id as a last resort), drawn in the
 * island's own rows.
 */

import type { ModelRef } from '@shared/models/slots.ts';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useModels } from '../features/models/ModelsContext.tsx';
import {
  describeRef,
  isCurrent,
  type PickerOption,
  type PickerSection,
  pickerSections,
} from '../features/models/pickerLogic.ts';
import { Icon } from './icons.tsx';

export function ModelPane({
  active,
  value,
  emptyLabel,
  emptyFollows,
  head,
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
  onPick: (ref: ModelRef | null) => void;
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

  const pick = (ref: ModelRef | null) => {
    if (ref) rememberModel(ref);
    onPick(ref);
  };

  const onKey = (event: KeyboardEvent) => {
    const options = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []),
    ];
    if (!options.length) return;
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
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
        onClick={() => pick(entry.ref)}
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
        title={entry.favorite ? 'Remove from favourites' : 'Add to favourites'}
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
    <div className="w3-mp" onKeyDown={onKey}>
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
          title="Fetch every connection's model list again"
          aria-label="Fetch the model lists again"
          onClick={() => loadCatalogs(true)}
        >
          <Icon name="refresh" size="sm" />
        </button>
      </label>
      <div className="w3-opt-list w3-mp__list" role="listbox" aria-label="Models" ref={listRef}>
        {emptyLabel && !query.trim() ? (
          <button
            type="button"
            role="option"
            className="w3-opt"
            aria-selected={!value}
            data-on={!value || undefined}
            tabIndex={-1}
            onClick={() => pick(null)}
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
        <span>↑ ↓ to move, Enter to choose</span>
        <span>Esc closes</span>
      </div>
    </div>
  );
}
