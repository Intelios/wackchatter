/**
 * Choosing which cards a blind round may draw, at library scale.
 *
 * The previous control was a wall of checkboxes, which is the wrong control for a library of
 * characters in an app about characters — but an unbounded grid of faces is worse. A
 * development library is six cards; a real one is two hundred to two thousand, and rendering
 * all of them as tiles would be several thousand pixels of images below a heading.
 *
 * Four rules keep it honest at any size:
 *
 *  - **The well is capped and scrolls**, exactly as the checkbox list already did. That
 *    constraint was right; this inherits it rather than discovering it again.
 *  - **Selected cards pin to the top**, in their own counted group. At two hundred cards the
 *    question is almost always "what is in my draw right now", and that must never require
 *    scrolling to answer.
 *  - **Search and filters**, because two hundred of anything needs search. Folders and tags
 *    are filters here because the library already has both, and the picker honours the app's
 *    hidden tags — a card you deliberately hid must not reappear in this list.
 *  - **Avatars are lazy.** This section used to render text and cost nothing; two hundred
 *    faces is two hundred image requests unless every tile says so.
 */

import type { CharacterSummary } from '@shared/types/card.ts';
import { useMemo, useState } from 'react';
import { SearchIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { matchesQuery, visibleTagsOf } from '../character/characterTree.ts';

interface CardPickerProps {
  characters: readonly CharacterSummary[];
  /** Avatar filenames in the draw. Empty means the whole library — see `everyCard`. */
  selected: readonly string[];
  everyCard: boolean;
  onToggle: (avatar: string) => void;
  onUseEvery: () => void;
  hiddenTags: readonly string[];
  /** How many recorded rounds each card has been drawn for. */
  playCounts: ReadonlyMap<string, number>;
}

/** Filters offered before the list becomes a list of filters. */
const MAX_TAG_FILTERS = 8;

export function CardPicker({
  characters,
  selected,
  everyCard,
  onToggle,
  onUseEvery,
  hiddenTags,
  playCounts,
}: CardPickerProps) {
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);

  const chosen = useMemo(() => new Set(selected), [selected]);

  const folders = useMemo(() => {
    const seen = new Map<string, number>();
    for (const character of characters) {
      if (!character.folder) continue;
      seen.set(character.folder, (seen.get(character.folder) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [characters]);

  /*
   * Tags, minus the ones the user has hidden app-wide.
   *
   * Not cosmetic: hiding a tag is how someone keeps a category out of sight, and a picker
   * that offered it as a filter would put it straight back on screen.
   */
  const tags = useMemo(() => {
    const seen = new Map<string, number>();
    for (const character of characters) {
      for (const entry of visibleTagsOf(character.tags, hiddenTags)) {
        seen.set(entry, (seen.get(entry) ?? 0) + 1);
      }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TAG_FILTERS);
  }, [characters, hiddenTags]);

  const visible = useMemo(
    () =>
      characters.filter((character) => {
        if (folder !== null && character.folder !== folder) return false;
        if (
          tag !== null &&
          !visibleTagsOf(character.tags, hiddenTags).some(
            (entry) => entry.toLowerCase() === tag.toLowerCase(),
          )
        ) {
          return false;
        }
        return matchesQuery(character, query);
      }),
    [characters, folder, hiddenTags, query, tag],
  );

  const inDraw = visible.filter((character) => chosen.has(character.avatar));
  const rest = visible.filter((character) => !chosen.has(character.avatar));

  const tile = (character: CharacterSummary, on: boolean) => {
    const played = playCounts.get(character.avatar) ?? 0;
    return (
      <li key={character.avatar}>
        <button
          type="button"
          className="arena-pick"
          data-on={on}
          aria-pressed={on}
          onClick={() => onToggle(character.avatar)}
          title={
            on ? `Remove ${character.name} from the draw` : `Add ${character.name} to the draw`
          }
        >
          <img src={characterApi.imageUrl(character.avatar)} alt="" loading="lazy" />
          <span className="arena-pick__name">{character.name}</span>
          <span className="arena-pick__count">
            {played > 0 ? `${played} ${played === 1 ? 'round' : 'rounds'}` : '—'}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="arena-picker">
      <div className="arena-picker__bar">
        <label className="arena-picker__search">
          <SearchIcon />
          <input
            type="search"
            className="arena-picker__input"
            value={query}
            placeholder={`Search ${characters.length} cards…`}
            aria-label="Search the card library"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="arena-picker__count">
          {everyCard ? (
            <>
              <b>Every card</b> · {characters.length} in the draw
            </>
          ) : (
            <>
              <b>{selected.length}</b> of {characters.length} in the draw
            </>
          )}
        </span>
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={onUseEvery}
          disabled={everyCard}
          title={everyCard ? 'Already drawing from the whole library' : 'Draw from every card'}
        >
          Use every card
        </button>
      </div>

      {folders.length > 0 || tags.length > 0 ? (
        <div className="arena-picker__filters">
          <button
            type="button"
            className="arena-tag"
            data-on={folder === null && tag === null}
            onClick={() => {
              setFolder(null);
              setTag(null);
            }}
          >
            Everything
          </button>
          {folders.map(([path, count]) => (
            <button
              key={path}
              type="button"
              className="arena-tag"
              data-on={folder === path}
              onClick={() => setFolder(folder === path ? null : path)}
            >
              {path}
              <small>{count}</small>
            </button>
          ))}
          {tags.map(([entry, count]) => (
            <button
              key={entry}
              type="button"
              className="arena-tag"
              data-on={tag === entry}
              onClick={() => setTag(tag === entry ? null : entry)}
            >
              {entry}
              <small>{count}</small>
            </button>
          ))}
        </div>
      ) : null}

      <div className="arena-picker__scroll">
        {visible.length === 0 ? <p className="wc-empty">No cards match that.</p> : null}

        {inDraw.length > 0 ? (
          <>
            <p className="arena-picker__group">In the draw — {inDraw.length}</p>
            <ul className="arena-picks">{inDraw.map((character) => tile(character, true))}</ul>
          </>
        ) : null}

        {rest.length > 0 ? (
          <>
            <p className="arena-picker__group">
              {everyCard
                ? `The library — ${rest.length}`
                : inDraw.length > 0
                  ? `Everything else — ${rest.length}`
                  : `The library — ${rest.length}`}
            </p>
            <ul className="arena-picks">{rest.map((character) => tile(character, everyCard))}</ul>
          </>
        ) : null}
      </div>

      <p className="arena-picker__foot">
        {everyCard
          ? 'Drawing from your whole library. Pick any card to narrow it.'
          : 'Selected cards stay pinned to the top, so the draw pool is readable without hunting.'}
      </p>
    </div>
  );
}
