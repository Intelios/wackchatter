/**
 * Choosing the card a comparison is staged on.
 *
 * The medallion IS the trigger. The card is the venue — both contenders are being judged on
 * how well they play it — so the thing you click to change it should be the thing itself,
 * not a labelled field beside it. A native `<select>` here was the one control on the
 * masthead that looked like a form, and it dropped an operating-system list over a screen
 * that is otherwise entirely the app's own.
 *
 * Built on `Popover` via `renderTrigger`, because Popover is the app's only popup mechanism
 * and `ModelCombobox` already set the precedent for composing it rather than starting a
 * second one. The flip, the outside-click dismissal and the Escape focus-restore all come
 * from there; what lives here is the grid, the filtering and the roving focus.
 *
 * The list is faces, not names, and it inherits the Pool picker's shape: a searchable capped
 * well with lazy avatars, so it behaves the same at six cards and at six hundred.
 */

import type { CharacterSummary } from '@shared/types/card.ts';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Popover, type PopoverTriggerProps } from '../../components/Popover.tsx';
import { SearchIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { matchesQuery } from '../character/characterTree.ts';

interface CharacterPickerProps {
  characters: readonly CharacterSummary[];
  /** The staged card's avatar filename, or null for none. */
  value: string | null;
  onChange: (avatar: string) => void;
  /** Rendered under the medallion when nothing is chosen yet. */
  emptyLabel?: string;
}

/**
 * Below this the whole library fits without scrolling and a search field is pure chrome.
 * Above it, searching is the only way to find anything.
 */
const SEARCH_FROM = 10;

export function CharacterPicker({
  characters,
  value,
  onChange,
  emptyLabel = 'Choose a character…',
}: CharacterPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = characters.find((entry) => entry.avatar === value) ?? null;
  const searchable = characters.length > SEARCH_FROM;
  const filtered = query.trim()
    ? characters.filter((entry) => matchesQuery(entry, query))
    : characters;

  const tiles = useCallback((): HTMLButtonElement[] => {
    const found = popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    return found ? [...found] : [];
  }, []);

  /*
   * Opening starts from the current selection, not from the top.
   *
   * With a search field the caret goes there — you are most likely about to type. Without
   * one, focus lands on the card that is already staged, so the arrow keys start from where
   * you are rather than from wherever the library happens to begin.
   *
   * A layout effect, not a `requestAnimationFrame`: the popup's DOM already exists by the
   * time this runs, and a frame callback does not fire at all while the window is
   * backgrounded — which would open the picker with focus stranded on `<body>`.
   */
  useLayoutEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    if (searchable) {
      searchRef.current?.focus({ preventScroll: true });
      return;
    }
    const list = tiles();
    const current = list.find((tile) => tile.dataset.avatar === value) ?? list[0];
    current?.focus({ preventScroll: true });
    // `value` is a dependency and harmlessly so: choosing a card closes the popup in the
    // same update, so the re-run takes the `!open` branch rather than moving focus into
    // something on its way out.
  }, [open, searchable, tiles, value]);

  /**
   * How many tiles are on a row, read off the grid itself.
   *
   * The column count is responsive, so Up and Down cannot assume a number — asking the
   * layout is the only way for a vertical arrow to move vertically at every width.
   */
  const columns = useCallback((): number => {
    const grid = popupRef.current?.querySelector('.arena-cardpicker__grid');
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  }, []);

  const moveFocus = useCallback(
    (step: number) => {
      const list = tiles();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      // From the search field there is no current tile, so a downward step enters the grid
      // at the top rather than jumping a row into it.
      const next = current === -1 ? (step > 0 ? 0 : list.length - 1) : current + step;
      list[Math.max(0, Math.min(next, list.length - 1))]?.focus({ preventScroll: true });
    },
    [tiles],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveFocus(columns());
          break;
        case 'ArrowUp': {
          event.preventDefault();
          const list = tiles();
          const current = list.indexOf(document.activeElement as HTMLButtonElement);
          // Up from the first row returns to the search field rather than trapping focus
          // at the top of the grid.
          if (searchable && current > -1 && current < columns()) {
            searchRef.current?.focus({ preventScroll: true });
            break;
          }
          moveFocus(-columns());
          break;
        }
        case 'ArrowRight':
          if (document.activeElement === searchRef.current) break;
          event.preventDefault();
          moveFocus(1);
          break;
        case 'ArrowLeft':
          if (document.activeElement === searchRef.current) break;
          event.preventDefault();
          moveFocus(-1);
          break;
        case 'Home':
          if (document.activeElement === searchRef.current) break;
          event.preventDefault();
          tiles()[0]?.focus({ preventScroll: true });
          break;
        case 'End': {
          if (document.activeElement === searchRef.current) break;
          event.preventDefault();
          const list = tiles();
          list[list.length - 1]?.focus({ preventScroll: true });
          break;
        }
        default:
          break;
      }
    },
    [columns, moveFocus, searchable, tiles],
  );

  const choose = useCallback(
    (avatar: string) => {
      onChange(avatar);
      setOpen(false);
    },
    [onChange],
  );

  const renderTrigger = (props: PopoverTriggerProps) => (
    <button
      type="button"
      className="arena-stage__trigger"
      onClick={() => setOpen(!open)}
      {...props}
      ref={(node) => props.ref(node)}
    >
      <span className="arena-stage__medallion">
        {selected ? (
          <img src={characterApi.imageUrl(selected.avatar)} alt="" />
        ) : (
          <span className="arena-stage__blank" aria-hidden="true" />
        )}
        <span className="arena-stage__vs">VS</span>
      </span>
      <span className="arena-stage__name" data-empty={selected === null}>
        {selected ? selected.name : emptyLabel}
      </span>
      <span className="arena-stage__role">
        {selected ? 'The card they’re playing' : 'Pick the card they play'}
      </span>
    </button>
  );

  return (
    <Popover
      label="Character"
      icon={null}
      open={open}
      onOpenChange={setOpen}
      className="arena-stage"
      popupClassName="arena-cardpicker"
      placement="bottom-start"
      role="listbox"
      popupRef={popupRef}
      onKeyDown={onKeyDown}
      renderTrigger={renderTrigger}
    >
      {searchable ? (
        <label className="arena-cardpicker__search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            className="arena-cardpicker__input"
            value={query}
            placeholder={`Search ${characters.length} cards…`}
            aria-label="Search characters"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}

      <div className="arena-cardpicker__scroll">
        {filtered.length === 0 ? (
          <p className="arena-cardpicker__empty">No cards match that.</p>
        ) : (
          <div className="arena-cardpicker__grid">
            {filtered.map((entry) => (
              <button
                key={entry.avatar}
                type="button"
                role="option"
                aria-selected={entry.avatar === value}
                data-avatar={entry.avatar}
                data-on={entry.avatar === value}
                className="arena-cardpicker__tile"
                title={entry.name}
                onClick={() => choose(entry.avatar)}
              >
                <img src={characterApi.imageUrl(entry.avatar)} alt="" loading="lazy" />
                <span className="arena-cardpicker__label">{entry.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}
