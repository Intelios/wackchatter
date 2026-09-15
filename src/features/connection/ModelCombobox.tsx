/**
 * A searchable model picker for the Connection panel.
 *
 * The trigger IS the search field: focusing it opens a `Popover` listing the fetched
 * models, typing filters the list live, and arrow keys walk real DOM focus through the
 * options (the roving-focus convention from `Menu`, not `aria-activedescendant`). A typed
 * string that matches nothing commits as a raw model id, so this one control replaces both
 * the old native `<select>` and the free-text `<input>` fallback.
 *
 * Built on `Popover` via its `renderTrigger` hook — "Popover is the only popup mechanism",
 * so a combobox composes it rather than introducing a second popup system. The flip,
 * outside-click dismissal and `preventScroll` focus handling all come from `Popover`; what
 * lives here is filtering, roving focus, and the commit/revert rules.
 *
 * Opening always starts with a blank query and the full catalogue — the current selection is
 * highlighted in the list, not treated as a search term. Enter or an option click commits;
 * Tab and an outside click commit only after the user edited the query; Escape reverts.
 *
 * With no catalogue the input stays a plain text field: the popup never opens, so the field
 * shows the query while focused (what typing edits) and the committed display when not.
 * Without that, an empty catalogue would swallow every keystroke — there is no popup to
 * switch the display over to the query.
 */

import type { ProviderModel } from '@shared/providers/types.ts';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Popover, type PopoverTriggerProps } from '../../components/Popover.tsx';
import { ChevronIcon } from '../../layout/icons.tsx';
import './ModelCombobox.css';

interface ModelComboboxProps {
  models: ProviderModel[];
  value: string;
  onCommit: (model: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  /** Replaces both built-in placeholders — e.g. "Use group default" on an override field. */
  placeholder?: string;
}

type Intent = 'commit' | 'revert' | null;

function displayText(modelId: string, models: ProviderModel[]): string {
  if (!modelId) return '';
  const match = models.find((m) => m.id === modelId);
  return match ? match.name : modelId;
}

function resolveQuery(query: string, models: ProviderModel[]): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  const byName = models.find((m) => m.name.toLowerCase() === lower);
  if (byName) return byName.id;
  const byId = models.find((m) => m.id.toLowerCase() === lower);
  if (byId) return byId.id;
  return trimmed;
}

function formatHint(model: ProviderModel): string {
  const parts: string[] = [];
  if (model.contextLength) parts.push(`${Math.round(model.contextLength / 1000)}k ctx`);
  if (model.promptPrice !== undefined) {
    const perM = model.promptPrice * 1_000_000;
    parts.push(perM === 0 ? 'free' : `$${perM < 0.01 ? '<0.01' : perM.toFixed(2)}/M`);
  }
  return parts.join(' · ');
}

export function ModelCombobox({
  models,
  value,
  onCommit,
  disabled,
  disabledReason,
  placeholder,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState(displayText(value, models));
  // Local mirror of the committed id so the closed display updates immediately on commit,
  // before the parent's `value` prop catches up after the server round-trip.
  const [committed, setCommitted] = useState(value);

  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const intentRef = useRef<Intent>(null);
  const pendingValueRef = useRef<string | null>(null);
  const queryEditedRef = useRef(false);
  const skipNextFocusRef = useRef(false);

  // Sync local state when the parent's value changes externally (e.g. a provider switch
  // resets model to ''). A no-op render when the value already matches. A query the user
  // is mid-way through typing is left alone — a catalogue landing from a slow fetch, or a
  // parent re-render, must not strand a half-typed id in the field.
  useEffect(() => {
    setCommitted(value);
    if (!openRef.current && !queryEditedRef.current) setQuery(displayText(value, models));
  }, [value, models]);

  const filtered = query.trim()
    ? models.filter((m) => {
        const q = query.trim().toLowerCase();
        return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
      })
    : models;

  const options = useCallback((): HTMLButtonElement[] => {
    const found = popupRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="option"]:not(:disabled)',
    );
    return found ? [...found] : [];
  }, []);

  function moveFocus(step: number, to?: number) {
    const list = options();
    if (!list.length) return;
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = to ?? (current === -1 ? 0 : (current + step + list.length) % list.length);
    list[Math.max(0, Math.min(next, list.length - 1))]?.focus({ preventScroll: true });
  }

  // The single commit/revert point for a listed-model popup. An outside click leaves no
  // explicit intent, so it commits only when the user actually edited the blank search.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && openRef.current) {
        if (intentRef.current === 'revert') {
          setQuery(displayText(committed, models));
        } else if (intentRef.current === 'commit' || queryEditedRef.current) {
          const cv = pendingValueRef.current ?? resolveQuery(query, models);
          setCommitted(cv);
          setQuery(displayText(cv, models));
          onCommit(cv);
        } else {
          setQuery(displayText(committed, models));
        }
        intentRef.current = null;
        pendingValueRef.current = null;
        queryEditedRef.current = false;
      }
      openRef.current = next;
      setOpen(next);
    },
    [committed, models, onCommit, query],
  );

  function openIfListed() {
    if (models.length === 0) return;
    openRef.current = true;
    setOpen(true);
    // The selection is already marked in the list. Starting blank reveals the full catalogue
    // instead of incorrectly filtering it to the model that happened to be selected before.
    queryEditedRef.current = false;
    setQuery('');
  }

  function restoreInputFocus() {
    if (document.activeElement === inputRef.current) return;
    // Selecting an option moves focus to that button. Restore it to the field after closing,
    // but do not treat this programmatic focus as a request to immediately reopen the popup.
    skipNextFocusRef.current = true;
    inputRef.current?.focus({ preventScroll: true });
  }

  // Escape on the input: revert + close. Stopped here so `Popover`'s root handler does not
  // also run (it would commit, since it cannot tell Escape from outside-click).
  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' && openRef.current) {
      event.preventDefault();
      event.stopPropagation();
      intentRef.current = 'revert';
      handleOpenChange(false);
      return;
    }
    onRootKeyDown(event);
  }

  // Escape on an option: revert + close + restore focus to the input. Stopped at the
  // button so it never reaches `Popover`'s root handler.
  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      intentRef.current = 'revert';
      handleOpenChange(false);
      restoreInputFocus();
    }
  }

  // Arrow/Home/End/Enter/Tab for both the input-focused and option-focused states. These
  // bubble to the root (the input has no handler for them; the list wrapper only stops
  // Escape). `document.activeElement` decides which context applies.
  function onRootKeyDown(event: ReactKeyboardEvent) {
    const onInput = document.activeElement === inputRef.current;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (onInput) options()[0]?.focus({ preventScroll: true });
        else moveFocus(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (onInput) options()[options().length - 1]?.focus({ preventScroll: true });
        else moveFocus(-1);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0, 0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(0, options().length - 1);
        break;
      case 'Enter': {
        event.preventDefault();
        if (models.length === 0 && onInput) {
          const cv = resolveQuery(query, models);
          if (cv !== committed) {
            setCommitted(cv);
            setQuery(displayText(cv, models));
            onCommit(cv);
          }
          break;
        }
        if (onInput) {
          intentRef.current = queryEditedRef.current ? 'commit' : null;
          pendingValueRef.current = queryEditedRef.current ? resolveQuery(query, models) : null;
        } else {
          const focused = document.activeElement as HTMLButtonElement | null;
          intentRef.current = 'commit';
          pendingValueRef.current = focused?.dataset.modelId ?? resolveQuery(query, models);
        }
        handleOpenChange(false);
        restoreInputFocus();
        break;
      }
      case 'Tab':
        intentRef.current = queryEditedRef.current ? 'commit' : null;
        handleOpenChange(false);
        break;
      default:
        break;
    }
  }

  function selectOption(model: ProviderModel) {
    intentRef.current = 'commit';
    pendingValueRef.current = model.id;
    handleOpenChange(false);
    restoreInputFocus();
  }

  // When there is no catalogue to list, the combobox is a plain text field: blur commits,
  // matching the old fallback input. Listed-model popup commits go through
  // `handleOpenChange` only; otherwise its close and the input blur could race.
  function onInputBlur() {
    if (models.length > 0) return;
    const cv = resolveQuery(query, models);
    // Re-arm the external sync above: the edit is over, so later value changes may
    // repaint the field again.
    queryEditedRef.current = false;
    setCommitted(cv);
    setQuery(displayText(cv, models));
    if (cv !== committed) onCommit(cv);
  }

  const renderTrigger = (props: PopoverTriggerProps) => (
    <div className="model-combobox__field" data-open={open || undefined}>
      <input
        ref={(node) => {
          inputRef.current = node;
          props.ref(node);
        }}
        type="text"
        className="wc-input model-combobox__input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={props['aria-expanded']}
        aria-controls={props['aria-controls']}
        aria-label={props['aria-label']}
        aria-haspopup="listbox"
        title={props.title}
        disabled={props.disabled}
        value={open || focused ? query : displayText(committed, models)}
        placeholder={placeholder ?? (models.length > 0 ? 'Select a model…' : 'Model id')}
        onChange={(event) => {
          if (!openRef.current) openIfListed();
          queryEditedRef.current = true;
          setQuery(event.target.value);
        }}
        onFocus={() => {
          setFocused(true);
          if (skipNextFocusRef.current) {
            skipNextFocusRef.current = false;
            return;
          }
          if (!openRef.current) openIfListed();
        }}
        onClick={() => {
          // Focus is the usual opener, but focus does not re-fire on a click into an
          // already-focused field — Escape closes while keeping focus there, and a
          // catalogue can land after focus (slow fetch). A click must always reveal
          // the list.
          if (!openRef.current) openIfListed();
        }}
        onKeyDown={onInputKeyDown}
        onBlur={() => {
          setFocused(false);
          onInputBlur();
        }}
      />
      {models.length > 0 ? <ChevronIcon className="model-combobox__chevron" /> : null}
    </div>
  );

  return (
    <Popover
      label="Model"
      icon={null}
      open={open}
      onOpenChange={handleOpenChange}
      className="model-combobox"
      popupClassName="model-combobox__popup"
      placement="bottom-start"
      role="listbox"
      popupRef={popupRef}
      onKeyDown={onRootKeyDown}
      renderTrigger={renderTrigger}
      disabled={disabled}
      disabledReason={disabledReason}
    >
      <div className="model-combobox__list">
        {filtered.length > 0 ? (
          filtered.map((model) => {
            const hint = formatHint(model);
            return (
              <button
                type="button"
                key={model.id}
                role="option"
                className="model-combobox__option"
                data-model-id={model.id}
                data-active={model.id === committed || undefined}
                aria-selected={model.id === committed}
                tabIndex={-1}
                onClick={() => selectOption(model)}
                onKeyDown={onOptionKeyDown}
              >
                <span className="model-combobox__option-name">{model.name}</span>
                {hint ? <span className="model-combobox__option-hint">{hint}</span> : null}
              </button>
            );
          })
        ) : (
          <div className="model-combobox__empty">
            No matches — press Enter to use <code>{query.trim() || 'this id'}</code>
          </div>
        )}
      </div>
    </Popover>
  );
}
