/**
 * The app's own dropdown: a button that opens a listbox, never an operating-system list.
 *
 * A native `<select>` drops a list drawn by the OS over a screen that is otherwise entirely
 * the app's — the arena's pickers retired theirs for exactly that reason, and this is the
 * general version of what they built. It composes `Popover`, the only popup mechanism
 * here, so the flip, the outside-click dismissal and Escape's focus restore come from
 * there; this adds the options, roving focus, type-to-jump and an optional search.
 *
 * Values are compared with `===` and never pass through the DOM, so `0`, `false` and
 * `null` round-trip as themselves — the reason `SelectField` indexed its native options.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronIcon, SearchIcon } from '../layout/icons.tsx';
import { Popover, type PopoverPlacement, type PopoverTriggerProps } from './Popover.tsx';
import {
  filterChoices,
  SELECT_SEARCH_FROM,
  type SelectChoice,
  typeaheadIndex,
} from './selectLogic.ts';
import './Select.css';

export type { SelectChoice } from './selectLogic.ts';

interface SelectProps<T> {
  value: T;
  options: readonly SelectChoice<T>[];
  onChange: (value: T) => void;
  /** Accessible name, and the search box's. Usually the field's visible label. */
  label: string;
  /** Lands on the trigger, so a `<label htmlFor>` can point at it. */
  id?: string;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Force the search box on or off; by default it appears past ten options. */
  searchable?: boolean;
  placement?: PopoverPlacement;
  className?: string;
}

/** How long a pause ends a type-to-jump word, as in a native list. */
const TYPEAHEAD_RESET_MS = 700;

export function Select<T>({
  value,
  options,
  onChange,
  label,
  id,
  placeholder = '',
  disabled,
  disabledReason,
  searchable,
  placement = 'bottom-start',
  className,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex]! : null;
  const canSearch = searchable ?? options.length > SELECT_SEARCH_FROM;
  // Each option keeps its original index, so keys and "is this the selected one" survive
  // filtering, and two options with the same label stay distinct.
  const shown = useMemo(() => {
    const indexed = options.map((option, index) => ({ option, index }));
    if (!canSearch || !query.trim()) return indexed;
    const kept = new Set(filterChoices(options, query));
    return indexed.filter((entry) => kept.has(entry.option));
  }, [canSearch, options, query]);

  const optionButtons = useCallback(
    (): HTMLButtonElement[] => [
      ...(popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ??
        []),
    ],
    [],
  );

  /*
   * Opening starts from the current choice: the caret in the search box when there is one,
   * otherwise focus on the selected option. The list scrolls the choice to its middle in
   * its own box — scrollIntoView would also scroll every panel around the popup.
   *
   * A layout effect so the focus lands before paint; Popover's own layout effect, which
   * caps the popup's height, has already run by then because it is the child.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening is the only trigger
  useLayoutEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const popup = popupRef.current;
    const current = popup?.querySelector<HTMLButtonElement>('[role="option"][data-selected]');
    const first = optionButtons()[0];
    if (canSearch) searchRef.current?.focus({ preventScroll: true });
    else (current ?? first)?.focus({ preventScroll: true });
    if (popup && current) {
      popup.scrollTop = current.offsetTop - popup.clientHeight / 2 + current.offsetHeight / 2;
    }
  }, [open]);

  const moveFocus = useCallback(
    (step: number, to?: number) => {
      const list = optionButtons();
      if (!list.length) return;
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = to ?? (current === -1 ? 0 : current + step);
      if (next < 0 && canSearch) {
        searchRef.current?.focus({ preventScroll: true });
        return;
      }
      const target = list[Math.max(0, Math.min(next, list.length - 1))];
      target?.focus({ preventScroll: true });
      // Keep the focused option in view without scrolling anything but the list, and clear
      // of the search box pinned over the list's top edge.
      const popup = popupRef.current;
      if (popup && target) {
        const pinned = searchRef.current?.parentElement?.offsetHeight ?? 0;
        const bottom = target.offsetTop + target.offsetHeight;
        if (target.offsetTop - pinned < popup.scrollTop) {
          popup.scrollTop = target.offsetTop - pinned;
        } else if (bottom > popup.scrollTop + popup.clientHeight) {
          popup.scrollTop = bottom - popup.clientHeight;
        }
      }
    },
    [canSearch, optionButtons],
  );

  const choose = useCallback(
    (next: T) => {
      onChange(next);
      setOpen(false);
      // The option about to unmount holds focus; hand it back to the trigger.
      triggerRef.current?.focus({ preventScroll: true });
    },
    [onChange],
  );

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const inSearch = event.target === searchRef.current;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(1, inSearch ? 0 : undefined);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (!inSearch) moveFocus(-1);
        return;
      case 'Home':
      case 'End':
        if (inSearch) return;
        event.preventDefault();
        moveFocus(0, event.key === 'Home' ? 0 : optionButtons().length - 1);
        return;
      case 'Enter':
      case ' ': {
        // Chosen here rather than left to the button's own activation, which in Chrome
        // rides the keypress after Enter — one keyboard path, whatever sent the key.
        if (inSearch) {
          if (event.key === ' ') return; // a space is part of the search
          event.preventDefault();
          const first = shown.find((entry) => !entry.option.disabled);
          if (first) choose(first.option.value);
          return;
        }
        const index = Number((event.target as HTMLElement).dataset.index);
        const option = Number.isInteger(index) ? options[index] : undefined;
        if (option && !option.disabled) {
          event.preventDefault();
          choose(option.value);
        }
        return;
      }
      case 'Tab':
        setOpen(false);
        return;
      default:
        break;
    }
    if (inSearch || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // A printable key on an option: with a search box, it is the start of a search.
    if (canSearch) {
      event.preventDefault();
      setQuery((current) => current + event.key);
      searchRef.current?.focus({ preventScroll: true });
      return;
    }
    // Without one, type-to-jump across the enabled options, as a native list does.
    const now = Date.now();
    typed.current = {
      text:
        now - typed.current.at > TYPEAHEAD_RESET_MS ? event.key : typed.current.text + event.key,
      at: now,
    };
    const list = optionButtons();
    const labels = list.map((button) => button.dataset.label ?? '');
    const index = typeaheadIndex(
      labels,
      typed.current.text,
      list.indexOf(document.activeElement as HTMLButtonElement),
    );
    if (index >= 0) moveFocus(0, index);
  };

  const shownLabel = selected?.label ?? placeholder;
  const renderTrigger = (props: PopoverTriggerProps) => (
    <button
      type="button"
      id={id}
      className="wc-select wc-select-trigger"
      data-placeholder={selected ? undefined : true}
      {...props}
      // The value belongs in the name and the tooltip: a truncated choice is still readable.
      aria-label={`${label}: ${shownLabel || 'none'}`}
      title={disabled ? (disabledReason ?? label) : shownLabel || label}
      onClick={() => setOpen(!open)}
      onKeyDown={(event) => {
        if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          setOpen(true);
        }
      }}
      ref={(node) => {
        props.ref(node);
        triggerRef.current = node;
      }}
    >
      <span className="wc-select-trigger__text">{shownLabel}</span>
      <ChevronIcon className="wc-select-trigger__chevron" />
    </button>
  );

  return (
    // Escape closes this list and must stop here: inside another popup (a select in the
    // Guides popover, say) it would otherwise bubble on and close that one too.
    // biome-ignore lint/a11y/noStaticElementInteractions: a pass-through that only stops Escape
    <div
      className={`wc-select-root${className ? ` ${className}` : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) event.stopPropagation();
      }}
    >
      <Popover
        label={label}
        icon={null}
        open={open}
        onOpenChange={setOpen}
        className="wc-select-popover"
        popupClassName="wc-select-popup"
        placement={placement}
        role="listbox"
        popupRef={popupRef}
        onKeyDown={onKeyDown}
        renderTrigger={renderTrigger}
        disabled={disabled}
        disabledReason={disabledReason}
      >
        {canSearch ? (
          <div className="wc-select-search">
            <SearchIcon />
            <input
              ref={searchRef}
              className="wc-input"
              value={query}
              placeholder="Search…"
              aria-label={`Search ${label}`}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}
        {shown.length ? (
          shown.map(({ option, index }) => (
            <button
              type="button"
              role="option"
              key={index}
              className="wc-select-option"
              data-selected={index === selectedIndex || undefined}
              data-label={option.label}
              data-index={index}
              aria-selected={index === selectedIndex}
              tabIndex={-1}
              disabled={option.disabled}
              title={
                option.disabled
                  ? option.disabledReason
                  : option.description
                    ? `${option.label}\n${option.description}`
                    : option.label
              }
              onClick={() => choose(option.value)}
            >
              <span className="wc-select-option__label">{option.label}</span>
              {option.description ? (
                <span className="wc-select-option__description">{option.description}</span>
              ) : null}
            </button>
          ))
        ) : (
          <p className="wc-select-empty">No matches.</p>
        )}
      </Popover>
    </div>
  );
}
