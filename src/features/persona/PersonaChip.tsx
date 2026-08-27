/**
 * Who you are writing as, in the composer's tray.
 *
 * Switching a persona is a frequent, one-second act; managing them is a rare, ten-minute
 * one. They used to share the same 420px panel, and each was compromised by the other's
 * needs — the only route to a switch was the burger menu, the panel, and a scroll through a
 * grid that showed six faces at a time. This is the frequent half, moved to where the
 * decision is actually made.
 *
 * It also answers a question nothing else in the app answers while you write: who am I
 * right now. That is why the trigger carries the name and not just the face.
 */

import type { Persona } from '@shared/types/chat.ts';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Popover } from '../../components/Popover.tsx';
import { ChevronIcon, SearchIcon, UserIcon } from '../../layout/icons.tsx';
import { personaApi } from '../../lib/api.ts';
import {
  groupVariantsUnderBase,
  matchesPersonaQuery,
  orderPersonas,
  personaDisplayName,
} from './personaRoster.ts';
import './PersonaChip.css';

/**
 * How many recents the popover offers before the full list.
 *
 * Fewer than the cap stored in settings: the point of the section is the two or three
 * personas in play this week, and a list of eight is one you have to read rather than
 * recognise. The rest are a keystroke away in the search field.
 */
const RECENT_SHOWN = 5;

/** A row the arrow keys can land on. "Use none" is one of them — it is a real choice. */
type Option = { kind: 'persona'; persona: Persona } | { kind: 'none' };

interface PersonaChipProps {
  personas: Persona[];
  /** The persona this chat is actually using — resolved by `useChat`, not the raw setting. */
  active: Persona | null;
  recentIds: readonly string[];
  /** Cache-busting versions per persona id, so a replaced avatar does not show stale. */
  avatarVersions: Readonly<Record<string, number>>;
  onSelect: (id: string | null) => void;
  /** Opens the persona panel, for everything this popover deliberately does not do. */
  onManage: () => void;
}

export function PersonaChip({
  personas,
  active,
  recentIds,
  avatarVersions,
  onSelect,
  onManage,
}: PersonaChipProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const searching = query.trim().length > 0;
  const matches = personas.filter((persona) => matchesPersonaQuery(persona, query));

  /*
   * A search flattens the grouping completely, the same way `buildCharacterTree` drops
   * folder rows while filtering: with most of the library hidden, "Recent" and "All" are
   * two headings over one short list, and the split stops carrying information.
   */
  const { recent, rest } = searching
    ? { recent: [] as Persona[], rest: matches }
    : orderPersonas(matches, recentIds, RECENT_SHOWN);

  // In the full list, variants tuck under their base — the same order the panel's roster
  // shows, so the two lists never disagree about where a flavour lives.
  const orderedRest = searching ? rest : groupVariantsUnderBase(rest);

  const options: Option[] = [
    ...recent.map((persona) => ({ kind: 'persona' as const, persona })),
    ...orderedRest.map((persona) => ({ kind: 'persona' as const, persona })),
    ...(active && !searching ? [{ kind: 'none' as const }] : []),
  ];

  // Clamped rather than stored in range: the list shrinks as you type, and a cursor left
  // past the end would point at nothing while still reading as a selection.
  const activeIndex = options.length ? Math.min(cursor, options.length - 1) : -1;
  const activeId = activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined;

  // Reopening should not resume someone else's half-finished search.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setCursor(0);
  }, [open]);

  /*
   * The popup exists to be typed into, so the caret starts there.
   *
   * A layout effect with an explicit `preventScroll` rather than `autoFocus`: focusing an
   * element inside a popup scrolls it into view by default, which drags the transcript
   * behind the composer. Every focus call inside a popup in this app passes it.
   */
  useLayoutEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Keep the highlighted row visible when the list overflows its cap.
  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    const listbox = listboxRef.current;
    const row = listbox?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!listbox || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < listbox.scrollTop) {
      listbox.scrollTop = top;
    } else if (bottom > listbox.scrollTop + listbox.clientHeight) {
      listbox.scrollTop = bottom - listbox.clientHeight;
    }
  }, [open, activeIndex]);

  function avatarUrl(persona: Persona): string | null {
    return persona.avatar
      ? personaApi.avatarUrl(persona.id, avatarVersions[persona.id] ?? persona.avatar)
      : null;
  }

  function pick(option: Option) {
    onSelect(option.kind === 'none' ? null : option.persona.id);
    setOpen(false);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (options.length) setCursor((index) => (index + 1) % options.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length) setCursor((index) => (index - 1 + options.length) % options.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) pick(option);
    }
    // Escape is the Popover's, and it restores focus to the trigger.
  }

  function renderRow(option: Option, index: number) {
    const selected = index === activeIndex;
    const isNone = option.kind === 'none';
    const persona = isNone ? null : option.persona;
    const url = persona ? avatarUrl(persona) : null;

    return (
      <button
        type="button"
        key={isNone ? 'none' : persona!.id}
        id={`${listboxId}-${index}`}
        data-index={index}
        role="option"
        aria-selected={selected}
        className="persona-chip__row"
        data-cursor={selected || undefined}
        data-current={(persona ? persona.id === active?.id : !active) || undefined}
        data-variant={(persona ? persona.variantOf : undefined) || undefined}
        // Keep the search field focused so typing keeps filtering — the ordinary combobox
        // trick, without which a click would blur the list shut before it landed.
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setCursor(index)}
        onClick={() => pick(option)}
      >
        <PersonaFace persona={persona} url={url} />
        <span className="persona-chip__row-name">{isNone ? 'No persona' : persona!.name}</span>
        {persona?.variantLabel ? (
          <span className="persona-chip__variant">{persona.variantLabel}</span>
        ) : null}
        {(persona ? persona.id === active?.id : !active) ? (
          <span className="persona-chip__you">You</span>
        ) : null}
      </button>
    );
  }

  const activeUrl = active ? avatarUrl(active) : null;

  return (
    <Popover
      label={
        active
          ? `Writing as ${personaDisplayName(active)} — switch persona`
          : 'No persona — pick one'
      }
      icon={null}
      open={open}
      onOpenChange={setOpen}
      // Upward: the composer sits on the window's bottom edge, so a downward popup would
      // open into the edge with nowhere to go.
      placement="top-start"
      role="dialog"
      className="persona-chip"
      popupClassName="persona-chip__popup"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          className="persona-chip__trigger"
          data-empty={!active || undefined}
          onClick={() => setOpen(!open)}
        >
          <PersonaFace persona={active} url={activeUrl} />
          <span className="persona-chip__name">{active ? active.name : 'No persona'}</span>
          {/* The chip answers "who am I right now" — with variants in play, that includes
              which flavour, or three rows all say "John Doe". */}
          {active?.variantLabel ? (
            <span className="persona-chip__variant">{active.variantLabel}</span>
          ) : null}
          <ChevronIcon className="persona-chip__chevron" />
        </button>
      )}
    >
      <div className="persona-chip__search">
        <SearchIcon className="persona-chip__search-icon" />
        <input
          ref={searchRef}
          type="search"
          className="persona-chip__input"
          value={query}
          placeholder="Switch persona…"
          aria-label="Search personas"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={onSearchKeyDown}
        />
      </div>

      <div className="persona-chip__list" id={listboxId} role="listbox" ref={listboxRef}>
        {options.length === 0 ? (
          <p className="persona-chip__empty">No persona matches “{query.trim()}”.</p>
        ) : (
          <>
            {recent.length > 0 ? <p className="persona-chip__group">Recent</p> : null}
            {recent.map((persona, index) => renderRow({ kind: 'persona', persona }, index))}

            {orderedRest.length > 0 && !searching ? (
              <p className="persona-chip__group">All personas</p>
            ) : null}
            {orderedRest.map((persona, index) =>
              renderRow({ kind: 'persona', persona }, recent.length + index),
            )}

            {active && !searching ? renderRow({ kind: 'none' }, recent.length + rest.length) : null}
          </>
        )}
      </div>

      <div className="persona-chip__foot">
        <span className="persona-chip__keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move <kbd>↵</kbd> pick <kbd>esc</kbd> close
        </span>
        <button
          type="button"
          className="wc-button wc-button--ghost persona-chip__manage"
          onClick={() => {
            setOpen(false);
            onManage();
          }}
        >
          Manage…
        </button>
      </div>
    </Popover>
  );
}

/** The face, or the fallback initial, or the empty slot that means "nobody". */
function PersonaFace({ persona, url }: { persona: Persona | null; url: string | null }) {
  if (!persona) {
    return (
      <span className="persona-chip__face" data-empty>
        <UserIcon />
      </span>
    );
  }
  return (
    <span className="persona-chip__face">
      {url ? (
        <img src={url} alt="" loading="lazy" />
      ) : (
        <span aria-hidden="true">{persona.name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
