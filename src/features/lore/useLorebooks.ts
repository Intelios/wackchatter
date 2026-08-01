/**
 * Resolving which lorebooks apply to the open chat, and keeping them loaded.
 *
 * Loading is async and cacheable; activation is pure and synchronous. They are split
 * deliberately: if activation had to await a fetch, the message the user just typed would
 * not be in the scan buffer when the engine ran, and the entry it was meant to trigger
 * would fire one turn late.
 *
 * So this hook does the awaiting, up front, and hands `worldInfoForChat` a ready list.
 */

import type { CardDataV2 } from '@shared/types/card.ts';
import type { LorebookSummary, WorldInfoBook } from '@shared/types/worldinfo.ts';
import type { WorldInfoSource, WorldInfoSourceKind } from '@shared/worldinfo/activate.ts';
import { toWorldInfoBook } from '@shared/worldinfo/convert.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lorebookApi } from '../../lib/api.ts';

/** A book the engine will consult, as shown in the Lore tab. */
export interface ActiveBook {
  kind: WorldInfoSourceKind;
  name: string;
  entryCount: number;
}

interface UseLorebooksOptions {
  /** The selected character's card, for its embedded book and `extensions.world` link. */
  character: CardDataV2 | null;
  /** Books to load for every chat, by id. */
  globalIds: string[];
  /** All known books, so a link can be resolved without a round trip. */
  books: LorebookSummary[];
  /** Optional books referenced by personas. They are prefetched, but only the active one is used. */
  personaIds?: string[];
}

export interface UseLorebooks {
  /** Sources without a persona book, retained for callers that do not have a persona. */
  sources: WorldInfoSource[];
  active: ActiveBook[];
  /** Add the active persona's book ahead of every other source, with id-based deduplication. */
  sourcesForPersona: (id?: string) => WorldInfoSource[];
  activeForPersona: (id?: string) => ActiveBook[];
  /** Force a reload of one book after it has been edited. */
  invalidate: (id: string) => void;
}

interface ComposeSourcesOptions {
  character: CardDataV2 | null;
  linkedName: string | null;
  loaded: Record<string, WorldInfoBook>;
  globalIds: string[];
  personaId?: string;
}

/** Pure source composition, exported so precedence and deduplication stay testable. */
export function composeLorebookSources({
  character,
  linkedName,
  loaded,
  globalIds,
  personaId,
}: ComposeSourcesOptions): WorldInfoSource[] {
  const list: WorldInfoSource[] = [];
  const standaloneIds = new Set<string>();

  if (personaId && loaded[personaId]) {
    list.push({ kind: 'persona', name: personaId, book: loaded[personaId]! });
    standaloneIds.add(personaId);
  }

  const embedded = character?.character_book;
  if (embedded?.entries?.length) {
    list.push({
      kind: 'embedded',
      name: embedded.name || character?.name || 'Embedded',
      book: toWorldInfoBook(embedded),
    });
  }

  if (linkedName && loaded[linkedName] && !standaloneIds.has(linkedName)) {
    list.push({ kind: 'linked', name: linkedName, book: loaded[linkedName]! });
    standaloneIds.add(linkedName);
  }

  for (const id of globalIds) {
    if (standaloneIds.has(id)) continue;
    const book = loaded[id];
    if (book) {
      list.push({ kind: 'global', name: id, book });
      standaloneIds.add(id);
    }
  }

  return list;
}

export function useLorebooks({
  character,
  globalIds,
  books,
  personaIds = [],
}: UseLorebooksOptions): UseLorebooks {
  const [loaded, setLoaded] = useState<Record<string, WorldInfoBook>>({});
  const [version, setVersion] = useState(0);

  // Which standalone books this chat needs: the card's link plus anything marked global.
  const linkedName =
    typeof character?.extensions?.world === 'string' ? character.extensions.world : null;

  const wanted = useMemo(() => {
    const ids = new Set<string>(globalIds);
    if (linkedName) ids.add(linkedName);
    for (const id of personaIds) {
      if (id) ids.add(id);
    }
    // Only ask for books that exist — a card can link to one the user never imported, and
    // a 404 per render is not a useful way to say so.
    return [...ids].filter((id) => books.some((summary) => summary.id === id));
  }, [globalIds, linkedName, personaIds, books]);

  /**
   * Ids already fetched or in flight.
   *
   * A ref, and it tracks COMPLETED fetches as well as pending ones: `wanted` gets a new
   * identity whenever the book list refreshes, so checking only in-flight ids would
   * re-download every book on every refresh.
   */
  const fetched = useRef(new Set<string>());

  // `version` is not read in here — it is the refetch trigger. `invalidate` bumps it to
  // re-run this effect after clearing an id from the cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the refetch trigger
  useEffect(() => {
    let cancelled = false;

    for (const id of wanted) {
      if (fetched.current.has(id)) continue;
      fetched.current.add(id);

      lorebookApi
        .get(id)
        .then((book) => {
          if (!cancelled) setLoaded((current) => ({ ...current, [id]: book }));
        })
        .catch(() => {
          // A book that fails to load simply doesn't contribute — the Lore tab is where a
          // broken book is visible and fixable, and failing generation over it would not
          // help. Un-marked so a later render retries rather than giving up for good.
          fetched.current.delete(id);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [wanted, version]);

  /** Drop a book from the cache, so an edit to it is picked up on the next render. */
  const invalidate = useCallback((id: string) => {
    fetched.current.delete(id);
    setLoaded((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setVersion((v) => v + 1);
  }, []);

  const sourcesForPersona = useCallback(
    (personaId?: string) => {
      return composeLorebookSources({ character, linkedName, loaded, globalIds, personaId });
    },
    [character, linkedName, loaded, globalIds],
  );

  const sources = useMemo(() => sourcesForPersona(), [sourcesForPersona]);

  const toActive = useCallback(
    (list: WorldInfoSource[]): ActiveBook[] =>
      list.map((source) => ({
        kind: source.kind,
        name: source.name,
        entryCount: Object.keys(source.book.entries).length,
      })),
    [],
  );

  const active = useMemo(() => toActive(sources), [sources, toActive]);
  const activeForPersona = useCallback(
    (id?: string) => toActive(sourcesForPersona(id)),
    [sourcesForPersona, toActive],
  );

  return { sources, active, sourcesForPersona, activeForPersona, invalidate };
}
