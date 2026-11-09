/**
 * The Character Co-Creator's reading of a session, as pure functions: which of the card's
 * fields are written, and where a new version of a field differs from the one kept.
 */

import type { CardSlot, CardStash } from '@shared/types/cocreator.ts';

// ---------- The card's fields ----------

export interface CardField {
  slot: CardSlot;
  label: string;
  filled: boolean;
}

/** The fields every card is measured against, in the order the live card shows them. */
const MAIN: readonly [CardSlot, string][] = [
  ['name', 'Name'],
  ['description', 'Description'],
  ['personality', 'Personality'],
  ['scenario', 'Scenario'],
  ['first_mes', 'First message'],
  ['alternate_greeting', 'Greetings'],
  ['mes_example', 'Example dialogue'],
  ['tags', 'Tags'],
  ['creator_notes', 'Creator notes'],
];

/** Shown only once written: most cards never carry them. */
const EXTRA: readonly [CardSlot, string][] = [
  ['system_prompt', 'System prompt'],
  ['post_history_instructions', 'Post-history instructions'],
];

function slotFilled(stash: CardStash, slot: CardSlot): boolean {
  if (slot === 'alternate_greeting') return stash.alternate_greetings.length > 0;
  if (slot === 'tags') return stash.tags.length > 0;
  return Boolean(stash[slot]?.text.trim());
}

/** The card's fields and whether each is written; the two prompt fields only when they are. */
export function cardFields(stash: CardStash): CardField[] {
  const main = MAIN.map(([slot, label]) => ({ slot, label, filled: slotFilled(stash, slot) }));
  const extra = EXTRA.filter(([slot]) => slotFilled(stash, slot)).map(([slot, label]) => ({
    slot,
    label,
    filled: true,
  }));
  return [...main, ...extra];
}

/** How many of the nine main fields are written: the island's meter. */
export function filledCount(stash: CardStash): number {
  return MAIN.filter(([slot]) => slotFilled(stash, slot)).length;
}

export const MAIN_FIELD_COUNT = MAIN.length;

// ---------- Where a new version differs ----------

export interface DiffPart {
  text: string;
  /** Not in the other version. */
  changed: boolean;
}

/** Words and the whitespace after them, so joining the parts gives the text back exactly. */
function tokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

const LIMIT = 3_000_000;

/**
 * Two versions of a field, each split into what both share and what only it has, word by
 * word. A longest-common-subsequence over words, which is what a reader means by "what
 * changed"; past a size where that gets slow, only the shared start and end are matched.
 */
export function wordDiff(before: string, after: string): { before: DiffPart[]; after: DiffPart[] } {
  const a = tokens(before);
  const b = tokens(after);
  const word = (token: string) => token.trim();

  let start = 0;
  while (start < a.length && start < b.length && word(a[start]!) === word(b[start]!)) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    word(a[a.length - 1 - end]!) === word(b[b.length - 1 - end]!)
  ) {
    end++;
  }
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);

  const sharedA = new Array<boolean>(midA.length).fill(false);
  const sharedB = new Array<boolean>(midB.length).fill(false);
  if (midA.length * midB.length <= LIMIT && midA.length && midB.length) {
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * cols + j] =
          word(midA[i]!) === word(midB[j]!)
            ? table[(i + 1) * cols + j + 1]! + 1
            : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (word(midA[i]!) === word(midB[j]!)) {
        sharedA[i++] = true;
        sharedB[j++] = true;
      } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) i++;
      else j++;
    }
  }

  const build = (all: string[], mid: boolean[]): DiffPart[] => {
    const parts: DiffPart[] = [];
    all.forEach((token, index) => {
      const inMid = index >= start && index < all.length - end;
      const changed = inMid ? !mid[index - start] && Boolean(token.trim()) : false;
      const last = parts[parts.length - 1];
      if (last && last.changed === changed) last.text += token;
      else parts.push({ text: token, changed });
    });
    return parts;
  };
  return { before: build(a, sharedA), after: build(b, sharedB) };
}
