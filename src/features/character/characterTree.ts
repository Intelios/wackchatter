/**
 * Turning a flat character list plus a flat folder list into the rows the panel renders.
 *
 * Pure and separately tested, like buildChatMenu and composeLorebookSources: there is no DOM
 * test harness in this project, so the rules live here and the React component stays a
 * renderer. Everything that decides what appears where — grouping, ordering, folder counts,
 * what a search does to the structure — is in this file.
 *
 * The output is a FLAT array with a `depth` on each row rather than a nested structure. A flat
 * list is what a scroll container and a drag layer both want, and it keeps "which row is under
 * the cursor" a plain index lookup instead of a tree walk.
 */

import type { CharacterSummary } from '@shared/types/card.ts';

export type TreeRow =
  | {
      kind: 'folder';
      /** Full path, e.g. "Fantasy/Elves". Unique, so it doubles as the React key and drop id. */
      path: string;
      /** Last segment — what the user sees. */
      name: string;
      depth: number;
      /** Cards in this folder and every folder beneath it. */
      count: number;
      collapsed: boolean;
    }
  | { kind: 'character'; character: CharacterSummary; depth: number };

export interface CharacterTreeInput {
  characters: readonly CharacterSummary[];
  /** Folder paths from the server, including empty ones. */
  folders: readonly string[];
  collapsed: readonly string[];
  query: string;
  /** How the cards are ordered within their folder. 'name' is alphabetical. */
  sort: 'name' | 'rating';
  /** The user's ratings, keyed by avatar filename. Drives the rating sort. */
  ratings: Readonly<Record<string, number>>;
}

/** Name, tags and creator — the fields a person actually searches a card library by. */
export function matchesQuery(character: CharacterSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    character.name.toLowerCase().includes(q) ||
    character.creator.toLowerCase().includes(q) ||
    character.tags.some((tag) => tag.toLowerCase().includes(q))
  );
}

/** "Fantasy/Elves" -> ["Fantasy", "Fantasy/Elves"]. */
function ancestorsOf(path: string): string[] {
  const segments = path.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function leafOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Rating-descending, then name for the tie — unrated cards sink to the bottom. */
function byRating(
  a: CharacterSummary,
  b: CharacterSummary,
  ratings: Readonly<Record<string, number>>,
): number {
  return (ratings[b.avatar] ?? 0) - (ratings[a.avatar] ?? 0) || byName(a.name, b.name);
}

/** The comparator for the current sort mode, bound to the rating map. */
function bySort(
  sort: 'name' | 'rating',
  ratings: Readonly<Record<string, number>>,
): (a: CharacterSummary, b: CharacterSummary) => number {
  return sort === 'rating' ? (a, b) => byRating(a, b, ratings) : (a, b) => byName(a.name, b.name);
}

export function buildCharacterTree({
  characters,
  folders,
  collapsed,
  query,
  sort,
  ratings,
}: CharacterTreeInput): TreeRow[] {
  /*
   * A search flattens the structure completely: matches from every folder in one list, no
   * folder rows, and the caller turns dragging off.
   *
   * The same reasoning as the comment on LorebookEditor's drag — a drop has to land somewhere
   * the user can see it land. While a filter is hiding most of the tree, the folder a card was
   * dropped into may not be on screen at all, so the card would simply vanish. Showing the
   * folder each match came from (the row still carries `character.folder`) gives back the
   * context the flattening removed.
   */
  if (query.trim()) {
    return characters
      .filter((character) => matchesQuery(character, query))
      .sort(bySort(sort, ratings))
      .map((character) => ({ kind: 'character' as const, character, depth: 0 }));
  }

  /*
   * Ancestors are filled in from both sources. The server lists every directory, so this is
   * belt-and-braces for one real case: a folder created outside the app between a character
   * refresh and a folder refresh would otherwise have cards whose parent row does not exist,
   * and they would disappear from the panel entirely rather than merely being in a new folder.
   */
  const known = new Set<string>();
  for (const folder of folders) for (const path of ancestorsOf(folder)) known.add(path);
  for (const { folder } of characters) {
    if (folder) for (const path of ancestorsOf(folder)) known.add(path);
  }

  const childFolders = new Map<string, string[]>();
  for (const path of known) {
    const parent = parentOf(path);
    childFolders.set(parent, [...(childFolders.get(parent) ?? []), path]);
  }

  const cardsIn = new Map<string, CharacterSummary[]>();
  for (const character of characters) {
    const folder = character.folder;
    cardsIn.set(folder, [...(cardsIn.get(folder) ?? []), character]);
  }

  const countIn = (folder: string): number => {
    const prefix = `${folder}/`;
    return characters.filter((c) => c.folder === folder || c.folder.startsWith(prefix)).length;
  };

  const hidden = new Set(collapsed);
  const rows: TreeRow[] = [];

  // Folders before cards at each level, each group alphabetical — the file-browser convention,
  // and it keeps a folder's contents visually adjacent to its header.
  const walk = (parent: string, depth: number): void => {
    for (const path of (childFolders.get(parent) ?? []).sort(byName)) {
      const isCollapsed = hidden.has(path);
      rows.push({
        kind: 'folder',
        path,
        name: leafOf(path),
        depth,
        count: countIn(path),
        collapsed: isCollapsed,
      });
      if (!isCollapsed) walk(path, depth + 1);
    }

    for (const character of (cardsIn.get(parent) ?? []).sort(bySort(sort, ratings))) {
      rows.push({ kind: 'character', character, depth });
    }
  };

  walk('', 0);
  return rows;
}
