/**
 * The Lorebooks tool's rules, pure so they are pinned by tests: which books feed this chat,
 * how the last reply's lore maps onto a book's entries, and how each mark reads.
 */

import type { CharacterSummary } from '@shared/types/card.ts';
import type { LorebookSummary, WorldInfoEntry } from '@shared/types/worldinfo.ts';
import type {
  ActivatedEntry,
  ActivationResult,
  SkippedEntry,
  WorldInfoSource,
} from '@shared/worldinfo/activate.ts';

/** The book id the tool uses for the open card's own (embedded) book. */
export const CARD_BOOK = '@card';

export interface BookRow {
  id: string;
  name: string;
  entryCount: number;
  /** Cards that link to this book by name. Empty for the card's own book. */
  cards: CharacterSummary[];
  /** The card's own book: read here, edited in the Studio. */
  isCard: boolean;
  /** Consulted for the open chat. */
  feeds: boolean;
}

/**
 * Your books, the ones feeding this chat first. The open card's own book, when it has one,
 * leads the chat's books; it is not a file, so it appears only while its card is open.
 */
export function bookRows(
  books: readonly LorebookSummary[],
  characters: readonly CharacterSummary[],
  sources: readonly WorldInfoSource[],
): { thisChat: BookRow[]; other: BookRow[] } {
  const feeding = new Set(sources.filter((s) => s.kind !== 'embedded').map((s) => s.name));
  const rows = books.map<BookRow>((book) => ({
    id: book.id,
    name: book.name,
    entryCount: book.entryCount,
    cards: characters.filter((card) => card.linkedBook === book.id),
    isCard: false,
    feeds: feeding.has(book.id),
  }));
  const embedded = sources.find((s) => s.kind === 'embedded');
  const card: BookRow[] = embedded
    ? [
        {
          id: CARD_BOOK,
          name: embedded.name,
          entryCount: Object.keys(embedded.book.entries).length,
          cards: [],
          isCard: true,
          feeds: true,
        },
      ]
    : [];
  return {
    thisChat: [...card, ...rows.filter((row) => row.feeds)],
    other: rows.filter((row) => !row.feeds),
  };
}

export type ReplyMark =
  | { state: 'fired'; entry: ActivatedEntry }
  | { state: 'skipped'; entry: SkippedEntry };

/** Whether a result's entry came from this book. */
function fromBook(ref: { sourceKind: string; sourceName: string }, bookId: string): boolean {
  return bookId === CARD_BOOK
    ? ref.sourceKind === 'embedded'
    : ref.sourceKind !== 'embedded' && ref.sourceName === bookId;
}

/**
 * What the last reply did with each of a book's entries, by uid. A switched-off entry is
 * left unmarked: being off says nothing about the last reply.
 */
export function lastReplyMarks(
  result: ActivationResult | null,
  bookId: string,
): Map<number, ReplyMark> {
  const marks = new Map<number, ReplyMark>();
  if (!result) return marks;
  for (const entry of result.skipped) {
    if (entry.reason === 'disabled' || !fromBook(entry, bookId)) continue;
    marks.set(entry.uid, { state: 'skipped', entry });
  }
  // A fired entry wins over an earlier pass's skip (a delayed entry that fired later).
  for (const entry of result.activated) {
    if (fromBook(entry, bookId)) marks.set(entry.uid, { state: 'fired', entry });
  }
  return marks;
}

/** How many entries fired from each book, keyed as `lastReplyMarks` keys books. */
export function firedByBook(result: ActivationResult | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of result?.activated ?? []) {
    const id = entry.sourceKind === 'embedded' ? CARD_BOOK : entry.sourceName;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** The book the last reply drew on most: where the island's lore moment takes you. */
export function busiestBook(result: ActivationResult | null): string | null {
  let best: string | null = null;
  let most = 0;
  for (const [id, count] of firedByBook(result)) {
    if (count > most) {
      best = id;
      most = count;
    }
  }
  return best;
}

/** The island's line: how many fired, and the first few names. */
export function loreMoment(
  result: ActivationResult | null,
  shown = 3,
): { count: number; names: string[]; more: number } | null {
  const fired = result?.activated ?? [];
  if (!fired.length) return null;
  const names = [...new Set(fired.map((entry) => entry.label))];
  return {
    count: fired.length,
    names: names.slice(0, shown),
    more: Math.max(0, names.length - shown),
  };
}

/** Where a key was found, as a reader would say it. */
function whereFound(found: NonNullable<ActivatedEntry['matchedIn']>): string {
  const whose = found.isUser ? 'your' : `${found.name}’s`;
  const what = found.isUser ? 'message' : 'reply';
  if (found.back === 0) return `${whose} last ${what}`;
  return `${whose} ${what} ${found.back} back`;
}

/** Why an entry did or did not go into the last reply, in a sentence. */
export function whyLine(
  mark: ReplyMark | undefined,
  entry: WorldInfoEntry,
  scanDepth: number,
): string {
  if (!mark) {
    if (entry.disable) return 'Switched off, so it is never sent.';
    if (entry.constant) return 'Always on, but it did not go into the last reply.';
    if (!entry.key.some((key) => key.trim())) return 'It has no keys, so it never fires.';
    const depth = entry.scanDepth ?? scanDepth;
    return `Did not fire: none of its keys were in the last ${depth === 1 ? 'message' : `${depth} messages`}.`;
  }
  if (mark.state === 'fired') {
    const fired = mark.entry;
    if (fired.reason === 'constant') return 'Fired: it is always on.';
    const key = fired.matchedKey ? `‘${fired.matchedKey}’` : 'one of its keys';
    if (fired.reason === 'recursion') return `Fired: another entry’s text held ${key}.`;
    return fired.matchedIn
      ? `Fired: matched ${key} in ${whereFound(fired.matchedIn)}.`
      : `Fired: matched ${key}.`;
  }
  switch (mark.entry.reason) {
    case 'probability':
      return `Skipped: a key matched, but it lost its ${entry.probability}% chance roll this turn.`;
    case 'group': {
      const group = entry.group.split(/,\s*/)[0]?.trim();
      return `Skipped: another entry won its group${group ? `, ‘${group}’` : ''}.`;
    }
    case 'budget':
      return `Skipped: the lore budget was spent${mark.entry.tokens ? ` (it needed ${mark.entry.tokens} tokens)` : ''}.`;
    case 'delayed':
      return 'Skipped: it waits until other entries have fired.';
    case 'empty':
      return 'Skipped: it has no text.';
    case 'vectorized':
      return 'Skipped: it is marked for vector search, which this app does not do.';
    default:
      return 'Skipped.';
  }
}
