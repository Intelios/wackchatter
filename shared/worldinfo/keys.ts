/**
 * Key lists as text.
 *
 * A lorebook entry's keys are an array on disk but a single comma-separated line in the
 * editor, and the naive split is wrong: `/foo,bar/i` is one legal key — a regex literal —
 * and splitting it on commas produces two keys that match nothing.
 *
 * So the split is comma-aware but regex-aware first. Hence a module, and hence tests:
 * `TagField`'s plain `split(',')` is not safe here.
 */

/**
 * A comma-separated line into keys.
 *
 * Commas inside a `/…/` literal are part of the pattern. Detection is deliberately
 * shallow — a run that starts with `/` stays open until an unescaped `/` closes it — but
 * that is exactly the grammar `parseRegexLiteral` accepts, so anything this keeps whole
 * is something the matcher can actually use.
 */
export function splitKeys(line: string): string[] {
  const keys: string[] = [];
  let current = '';
  let inRegex = false;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '/') {
      // A `/` only opens a literal at the very start of a key; anywhere else it is
      // ordinary text, which keeps `and/or` from swallowing the rest of the line.
      if (!inRegex && current.trim() === '') inRegex = true;
      else if (inRegex) inRegex = false;
      current += char;
      continue;
    }

    if (char === ',' && !inRegex) {
      const key = current.trim();
      if (key) keys.push(key);
      current = '';
      continue;
    }

    current += char;
  }

  const last = current.trim();
  if (last) keys.push(last);
  return keys;
}

/** Keys back to an editable line. The inverse of splitKeys for anything it produced. */
export function joinKeys(keys: string[]): string {
  return keys.join(', ');
}
