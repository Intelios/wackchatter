/**
 * Pick a model, not a connection.
 *
 * One searchable list across every saved connection: starred favourites first, then recent
 * picks, then each connection's catalogue under its name — a big catalogue split by vendor —
 * then, once something is typed, that text as a raw model id on each connection, for
 * endpoints that list nothing. Group headings fold, and the picker remembers which. A pick is a whole
 * `ModelRef`, so there is no connection to choose first and nothing to spring back.
 *
 * Functional rather than final: the 3.0 interface designs the real picker. This one replaces
 * every connection-then-model control so the current interface runs on model slots.
 *
 * Built on `Popover` like every popup. The search field takes focus on open; the arrow keys
 * walk real DOM focus through the options (the `Menu` convention), and Enter in the field
 * takes the first match.
 */

import type { ModelRef } from '@shared/models/slots.ts';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Popover, type PopoverTriggerProps } from '../../components/Popover.tsx';
import { ChevronIcon, StarIcon } from '../../layout/icons.tsx';
import { useModels } from './ModelsContext.tsx';
import {
  describeRef,
  isCurrent,
  type PickerOption,
  type PickerSection,
  pickerSections,
} from './pickerLogic.ts';
import './ModelPicker.css';

export interface ModelPickerProps {
  value: ModelRef | null | undefined;
  onChange: (ref: ModelRef | null) => void;
  /**
   * Offer an empty choice under this name — "Same as chat", say. Without it the picker has
   * no way back to empty, for a slot that must hold a model once one is chosen.
   */
  emptyLabel?: string;
  /** The model an empty choice runs on, shown beside it so following is never a mystery. */
  emptyFollows?: ModelRef | null;
  /** Accessible name and tooltip. */
  label?: string;
  id?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function ModelPicker({
  value,
  onChange,
  emptyLabel,
  emptyFollows,
  label = 'Model',
  id,
  disabled,
  disabledReason,
}: ModelPickerProps) {
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(
    () =>
      open
        ? pickerSections({
            connections,
            recent: recentModels,
            favorites: favoriteModels,
            groups: pickerGroups,
            catalogs,
            query,
          })
        : [],
    [open, connections, recentModels, favoriteModels, pickerGroups, catalogs, query],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        setQuery('');
        loadCatalogs();
      }
    },
    [loadCatalogs],
  );

  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true });
  }, [open]);

  function pick(ref: ModelRef | null) {
    if (ref) rememberModel(ref);
    onChange(ref);
    setOpen(false);
  }

  function options(): HTMLButtonElement[] {
    const found = popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    return found ? [...found] : [];
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    const list = options();
    if (!list.length) return;
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (n: number) =>
      list[(n + list.length) % list.length]?.focus({ preventScroll: true });
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focus(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index <= 0) searchRef.current?.focus({ preventScroll: true });
      else focus(index - 1);
    } else if (event.key === 'Enter' && document.activeElement === searchRef.current) {
      event.preventDefault();
      list[0]?.click();
    }
  }

  const current = value ? describeRef(value, connections, catalogs) : null;
  const follows = !value && emptyFollows ? describeRef(emptyFollows, connections, catalogs) : null;

  const renderTrigger = (props: PopoverTriggerProps) => (
    <button
      ref={props.ref}
      id={id}
      type="button"
      className="wc-input model-picker__trigger"
      aria-haspopup={props['aria-haspopup']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      aria-label={props['aria-label']}
      title={props.title}
      disabled={props.disabled}
      onClick={() => handleOpenChange(!open)}
    >
      <span className="model-picker__value">
        {current ? (
          <>
            <span className="model-picker__name">{current.name}</span>
            <span className="model-picker__connection">
              {current.connectionName ?? 'deleted connection'}
            </span>
          </>
        ) : emptyLabel ? (
          <>
            <span className="model-picker__name">{emptyLabel}</span>
            {follows ? <span className="model-picker__connection">{follows.name}</span> : null}
          </>
        ) : (
          <span className="model-picker__placeholder">Choose a model…</span>
        )}
      </span>
      <ChevronIcon className="model-picker__chevron" />
    </button>
  );

  const renderOption = (option: PickerOption) => (
    <div
      key={option.key}
      className="model-picker__row"
      data-favorite={option.favorite || undefined}
    >
      <button
        type="button"
        role="option"
        className="model-picker__option"
        aria-selected={isCurrent(option, value)}
        data-active={isCurrent(option, value) || undefined}
        tabIndex={-1}
        onClick={() => pick(option.ref)}
      >
        <span className="model-picker__option-name">{option.name}</span>
        <span className="model-picker__option-meta">
          {option.hint ? `${option.hint} · ` : ''}
          {option.connectionName}
        </span>
      </button>
      <button
        type="button"
        className="model-picker__star"
        aria-pressed={option.favorite}
        aria-label={option.favorite ? `Unstar ${option.name}` : `Star ${option.name}`}
        title={option.favorite ? 'Remove from favourites' : 'Add to favourites'}
        onClick={() => toggleFavorite(option.ref)}
      >
        <StarIcon filled={option.favorite} />
      </button>
    </div>
  );

  const renderSection = (section: PickerSection, depth = 0): ReactNode => {
    const body = section.open ? (
      <>
        {section.note ? <div className="model-picker__note">{section.note}</div> : null}
        {section.options.map(renderOption)}
        {section.groups?.map((group) => renderSection(group, depth + 1))}
      </>
    ) : null;
    return (
      <div key={section.key} className="model-picker__section" data-depth={depth || undefined}>
        {section.collapsible ? (
          <button
            type="button"
            className="model-picker__section-title model-picker__fold"
            aria-expanded={section.open}
            onClick={() => setGroupOpen(section.key, !section.open)}
          >
            <ChevronIcon className="model-picker__fold-chevron" />
            <span>{section.title}</span>
            <span className="model-picker__count">{section.count}</span>
          </button>
        ) : (
          <div className="model-picker__section-title">{section.title}</div>
        )}
        {body}
      </div>
    );
  };

  return (
    <Popover
      label={label}
      icon={null}
      open={open}
      onOpenChange={handleOpenChange}
      className="model-picker"
      popupClassName="model-picker__popup"
      placement="bottom-start"
      role="dialog"
      popupRef={popupRef}
      onKeyDown={onKeyDown}
      renderTrigger={renderTrigger}
      disabled={disabled}
      disabledReason={disabledReason}
    >
      <div className="model-picker__search">
        <input
          ref={searchRef}
          type="search"
          className="wc-input"
          placeholder="Search models, or type a model id"
          aria-label="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="wc-button wc-button--ghost model-picker__refresh"
          title="Fetch every connection's model list again"
          onClick={() => loadCatalogs(true)}
        >
          Refresh
        </button>
      </div>
      <div className="model-picker__list" role="listbox" aria-label={label}>
        {emptyLabel && !query.trim() ? (
          <button
            type="button"
            role="option"
            className="model-picker__option"
            aria-selected={!value}
            data-active={!value || undefined}
            tabIndex={-1}
            onClick={() => pick(null)}
          >
            <span className="model-picker__option-name">{emptyLabel}</span>
            {follows ? (
              <span className="model-picker__option-meta">
                {follows.name}
                {follows.connectionName ? ` · ${follows.connectionName}` : ''}
              </span>
            ) : null}
          </button>
        ) : null}
        {sections.map((section) => renderSection(section))}
        {!connections.length ? (
          <div className="model-picker__note">Add a connection in Connections first.</div>
        ) : null}
      </div>
    </Popover>
  );
}
