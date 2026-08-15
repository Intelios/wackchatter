/**
 * The card sheet's contents: find, the section index, and the section you are reading.
 *
 * Shared verbatim by the popover on the avatar and the full-column reader, so the two are
 * the same surface at two sizes rather than two implementations that will drift. It knows
 * nothing about popups or overlays — the container supplies the box and the header
 * actions, this supplies the three bands.
 *
 * Read-only by design. The moment a reading surface grows an input bound to the card it
 * stops being a glance and becomes the editor panel this feature exists to avoid; the way
 * back to editing is a button that leaves.
 */

import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon } from '../../layout/icons.tsx';
import {
  type CardSearch,
  firstHitSection,
  highlightParts,
  matchesIn,
  searchCard,
} from './cardSearch.ts';
import { type CardSheet, resolveSectionId } from './cardSheet.ts';
import { Markdown } from './Markdown.tsx';
import { recallSection, rememberSection } from './state/cardStore.ts';
import './CardSheet.css';

export interface CardSheetState {
  query: string;
  setQuery: (query: string) => void;
  /** Always a section the sheet actually has — see `resolveSectionId`. */
  sectionId: string;
  selectSection: (id: string) => void;
  search: CardSearch;
}

/**
 * Query, open section, and the one rule connecting them.
 *
 * A hook rather than props so the popover and the reader behave identically without
 * either of them owning the logic. Seeded from the session's memory of this card, which is
 * why `avatar` is here at all.
 */
export function useCardSheetState(
  sheet: CardSheet,
  avatar: string | null,
  init?: { query?: string; sectionId?: string | null },
): CardSheetState {
  const [query, setQuery] = useState(init?.query ?? '');
  // Seeded once. Re-reading the memory every render would let a second open sheet move
  // this one, and `resolveSectionId` below already covers the card changing underneath.
  const [chosen, setChosen] = useState<string | null>(
    () => init?.sectionId ?? recallSection(avatar),
  );

  const sectionId = resolveSectionId(sheet, chosen);
  const search = useMemo(() => searchCard(sheet.sections, query), [sheet.sections, query]);

  const selectSection = useCallback(
    (id: string) => {
      setChosen(id);
      if (avatar) rememberSection(avatar, id);
    },
    [avatar],
  );

  /*
   * A query with no hits here, but hits elsewhere, moves you to where the answer is.
   *
   * Keyed on the query actually changing rather than on the search result: a chip you
   * clicked has to win, and without the guard, opening a hit-less section while a query
   * was live would bounce you straight back out of it.
   */
  const previousQuery = useRef(query);
  useEffect(() => {
    if (previousQuery.current === query) return;
    previousQuery.current = query;
    const jump = firstHitSection(search, sectionId);
    if (jump) selectSection(jump);
  }, [query, search, sectionId, selectSection]);

  return { query, setQuery, sectionId, selectSection, search };
}

interface CardSheetViewProps extends CardSheetState {
  sheet: CardSheet;
  variant: 'popover' | 'reader';
  /** Expand, Edit card — whatever the container offers. Sits in the find row. */
  actions?: ReactNode;
  /** The scrolling element, so the container can put a jumped-to section back in view. */
  bodyRef?: RefObject<HTMLDivElement | null>;
  /** Focus the find box on mount. The reader does; the popover leaves focus on the trigger. */
  autoFocus?: boolean;
}

export function CardSheetView({
  sheet,
  variant,
  actions,
  bodyRef,
  autoFocus,
  query,
  setQuery,
  sectionId,
  selectSection,
  search,
}: CardSheetViewProps) {
  const section = sheet.sections.find((entry) => entry.id === sectionId) ?? sheet.sections[0];
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // preventScroll, per the house rule: the layout is fixed to the viewport, and a browser
    // scrolling to reveal an element drags the whole app out from under it.
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const hits = search.query ? search.matches.length : 0;

  return (
    <div className="card-sheet" data-variant={variant}>
      <div className="card-sheet__find">
        <SearchIcon className="card-sheet__find-icon" />
        <input
          ref={inputRef}
          type="text"
          className="card-sheet__input"
          value={query}
          spellCheck={false}
          autoComplete="off"
          aria-label="Find in card"
          placeholder="Find in card"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears before it closes — one key that means "undo the narrowing",
            // and only once there is nothing left to undo does Popover's own handler get
            // it and shut the sheet.
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        {search.query ? (
          <span className="card-sheet__count" data-empty={hits === 0 || undefined}>
            {hits === 0 ? 'no matches' : `${hits} ${hits === 1 ? 'hit' : 'hits'}`}
          </span>
        ) : null}
        {actions}
      </div>

      {/* One chip is not an index — at the raw rung there is nothing to choose between. */}
      {sheet.rung !== 'raw' ? (
        <div className="card-sheet__chips" role="tablist" aria-label="Card sections">
          {sheet.sections.map((entry) => {
            const count = search.counts.get(entry.id) ?? 0;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="card-sheet__chip"
                aria-selected={entry.id === sectionId}
                // Dimmed, never removed: a section the reader cannot reach is the one
                // thing the ladder promises never to produce.
                data-quiet={
                  search.query && count === 0 && !search.labelled.has(entry.id) ? '' : undefined
                }
                onClick={() => selectSection(entry.id)}
              >
                {entry.label}
                {count > 0 ? <span className="card-sheet__chip-count">{count}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="card-sheet__body" ref={bodyRef}>
        {section?.text.trim() ? (
          search.query ? (
            /*
             * Plain text while filtering.
             *
             * Rendered markdown and the source string are different offset spaces, so
             * marking hits inside the rendered tree would let the chips' counts and the
             * marks in the prose disagree — a confident lie, which is the failure this
             * whole feature is built to avoid. Clearing the box brings the formatting
             * straight back.
             */
            <p className="card-sheet__plain">
              {highlightParts(section.text, matchesIn(search, section.id)).map((part, index) =>
                part.hit ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional runs of one string
                  <mark key={index}>{part.text}</mark>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional runs of one string
                  <span key={index}>{part.text}</span>
                ),
              )}
            </p>
          ) : (
            <Markdown text={section.text} className="card-sheet__text" />
          )
        ) : (
          <p className="card-sheet__empty">This card has nothing written here.</p>
        )}
      </div>
    </div>
  );
}
