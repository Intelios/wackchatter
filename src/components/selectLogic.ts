/**
 * The keyboard and search rules behind `Select`, kept pure so they can be tested without a
 * DOM: which option a typed prefix lands on, and which options a search leaves.
 */

export interface SelectChoice<T> {
  value: T;
  label: string;
  /** A quieter second line — a greeting's opening words, a persona's variant. */
  description?: string;
  disabled?: boolean;
  /** Why it cannot be chosen. Becomes the option's title, so it still explains itself. */
  disabledReason?: string;
}

/** Below this many options the whole list fits, and a search box is pure chrome. */
export const SELECT_SEARCH_FROM = 10;

/** Case-insensitive match on the label or the description; an empty query keeps all. */
export function filterChoices<T>(
  choices: readonly SelectChoice<T>[],
  query: string,
): SelectChoice<T>[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...choices];
  return choices.filter(
    (choice) =>
      choice.label.toLowerCase().includes(needle) ||
      Boolean(choice.description?.toLowerCase().includes(needle)),
  );
}

/**
 * Where typing a prefix moves focus, as a native select does: the first label starting
 * with what was typed. A single character — or the same one repeated — steps to the
 * *next* match after `current`, so pressing "a" three times walks through the A's; a
 * longer prefix may keep the current option, because it is still being narrowed.
 *
 * Returns -1 when nothing matches, and focus should stay where it is.
 */
export function typeaheadIndex(labels: readonly string[], typed: string, current: number): number {
  const query = typed.toLowerCase();
  if (!query || !labels.length) return -1;
  const cycling = [...query].every((character) => character === query[0]);
  const needle = cycling ? query[0]! : query;
  const start = cycling ? current + 1 : Math.max(current, 0);
  for (let step = 0; step < labels.length; step += 1) {
    const index = (((start + step) % labels.length) + labels.length) % labels.length;
    if (labels[index]!.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}
