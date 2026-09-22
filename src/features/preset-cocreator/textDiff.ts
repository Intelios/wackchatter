/**
 * Word-level text diff for reading preset changes.
 *
 * Prompt blocks are usually one long line, so a line diff marks the whole block changed,
 * and the old History view showed two full copies of it. This diffs word tokens instead,
 * keeping whitespace and punctuation as their own tokens so line breaks survive and a
 * changed comma is a changed comma.
 *
 * Three passes, each for readability rather than minimality:
 * - Myers' O(ND) diff on the tokens, after trimming the common prefix and suffix (almost
 *   every real edit is local, so the expensive middle is usually small).
 * - Absorbing tiny equalities between two changes (a lone "the", a space) into the change,
 *   so a rewritten phrase reads as one strike-and-insert rather than confetti.
 * - Falling back to plain before/after blocks when most of the text changed, where a word
 *   diff would be all colour and no information.
 */

export type DiffPart = { kind: 'same' | 'removed' | 'added'; text: string };

export type TextDiff =
  | { mode: 'words'; parts: DiffPart[]; addedWords: number; removedWords: number }
  | { mode: 'rewritten'; before: string; after: string; addedWords: number; removedWords: number };

/** A folded stretch of unchanged text: shown as "⋯ N unchanged words ⋯", expandable. */
export type DisplayPart = DiffPart | { kind: 'fold'; text: string; words: number };

/**
 * Whitespace runs, words (letters, digits, underscore, inner apostrophes), or any single
 * other character. Every character matches exactly one alternative, so the tokens always
 * join back to the input — the property everything below leans on.
 */
const TOKEN = /\s+|[\p{L}\p{N}\p{M}_]+(?:['’][\p{L}\p{N}\p{M}_]+)*|[^\s\p{L}\p{N}\p{M}_]/gu;
const WORD = /[\p{L}\p{N}]/u;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

const isWord = (token: string) => WORD.test(token);
const countWords = (tokens: readonly string[]) => tokens.filter(isWord).length;

/** More than this many token edits and the text is treated as rewritten. Bounds memory. */
const MAX_EDITS = 2000;
/** Share of changed words above which the before/after view reads better than a diff. */
const REWRITE_RATIO = 0.6;
/** Below this many words in total, even a heavy change is short enough to diff. */
const REWRITE_MIN_WORDS = 12;

type Op = 'same' | 'removed' | 'added';

/**
 * Myers' shortest edit script, returning per-token ops, or null past `maxEdits`.
 *
 * The trace keeps only the diagonals each step can reach — O(D²) rather than O(D·(N+M)) —
 * which is what makes the cap affordable on a 13,000-character prompt.
 */
function myers(a: readonly string[], b: readonly string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;

  for (let d = 0; d <= limit && found < 0; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d -= 1) {
    const row = trace[d]!;
    const at = (k: number) => row[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push('same');
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      ops.push(x === previousX ? 'added' : 'removed');
      if (x === previousX) y -= 1;
      else x -= 1;
    }
  }
  return ops.reverse();
}

function mergeOps(a: readonly string[], b: readonly string[], ops: readonly Op[]): DiffPart[] {
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    const token = op === 'added' ? b[j++]! : a[i++]!;
    if (op === 'same') j += 1;
    const last = parts.at(-1);
    if (last?.kind === op) last.text += token;
    else parts.push({ kind: op, text: token });
  }
  return parts;
}

/** An equality this small between two changes reads better as part of the change. */
function isAbsorbable(text: string): boolean {
  if (!text.trim()) return true;
  const tokens = tokenize(text).filter((token) => token.trim());
  return tokens.length <= 1 && text.trim().length <= 3;
}

/**
 * Fold tiny equalities into the changes around them, then write each change region as
 * one removal followed by one addition — the order a reader compares them in.
 */
function cleanup(parts: readonly DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let removed = '';
  let added = '';
  const flush = () => {
    if (removed) out.push({ kind: 'removed', text: removed });
    if (added) out.push({ kind: 'added', text: added });
    removed = '';
    added = '';
  };
  parts.forEach((part, index) => {
    if (part.kind === 'removed') removed += part.text;
    else if (part.kind === 'added') added += part.text;
    else if (index > 0 && index < parts.length - 1 && isAbsorbable(part.text)) {
      removed += part.text;
      added += part.text;
    } else {
      flush();
      out.push({ ...part });
    }
  });
  flush();
  return out;
}

export function diffText(before: string, after: string, maxEdits = MAX_EDITS): TextDiff {
  const a = tokenize(before);
  const b = tokenize(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const beforeWords = countWords(a);
  const afterWords = countWords(b);
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const ops = myers(middleA, middleB, maxEdits);
  const rewritten = (removedWords: number, addedWords: number): TextDiff => ({
    mode: 'rewritten',
    before,
    after,
    addedWords,
    removedWords,
  });
  if (!ops) return rewritten(beforeWords, afterWords);

  const parts = cleanup([
    ...(start ? [{ kind: 'same' as const, text: a.slice(0, start).join('') }] : []),
    ...mergeOps(middleA, middleB, ops),
    ...(endA < a.length ? [{ kind: 'same' as const, text: a.slice(endA).join('') }] : []),
  ]);

  let addedWords = 0;
  let removedWords = 0;
  for (const part of parts) {
    if (part.kind === 'added') addedWords += countWords(tokenize(part.text));
    if (part.kind === 'removed') removedWords += countWords(tokenize(part.text));
  }
  const total = beforeWords + afterWords;
  if (total >= REWRITE_MIN_WORDS && (addedWords + removedWords) / total > REWRITE_RATIO) {
    return rewritten(removedWords, addedWords);
  }
  return { mode: 'words', parts, addedWords, removedWords };
}

/** How many words of unchanged context stay visible on each side of a change. */
export const FOLD_CONTEXT_WORDS = 12;
/** Folding fewer words than this hides nothing worth hiding. */
const FOLD_MIN_HIDDEN = 8;

const isSpace = (token: string) => !token.trim();

/**
 * Split tokens after the `count`th word from the start (or before it, from the end), then
 * slide to the nearest whitespace so a fold never cuts `{{user}}` into `{{user` and `}}`.
 */
function splitAtWords(tokens: readonly string[], count: number, fromEnd: boolean): number {
  let seen = 0;
  if (!fromEnd) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (isWord(tokens[index]!) && ++seen === count) {
        let end = index + 1;
        while (end < tokens.length && !isSpace(tokens[end]!)) end += 1;
        return end;
      }
    }
    return tokens.length;
  }
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (isWord(tokens[index]!) && ++seen === count) {
      let start = index;
      while (start > 0 && !isSpace(tokens[start - 1]!)) start -= 1;
      return start;
    }
  }
  return 0;
}

/**
 * Collapse long unchanged stretches to a fold, keeping `context` words beside each change.
 * The fold keeps its text, so expanding it in place loses nothing.
 */
export function foldParts(parts: readonly DiffPart[], context = FOLD_CONTEXT_WORDS): DisplayPart[] {
  const out: DisplayPart[] = [];
  parts.forEach((part, index) => {
    if (part.kind !== 'same') {
      out.push(part);
      return;
    }
    const tokens = tokenize(part.text);
    const first = index === 0;
    const last = index === parts.length - 1;
    const keepHead = first ? 0 : splitAtWords(tokens, context, false);
    const keepTail = last ? tokens.length : splitAtWords(tokens, context, true);
    if (keepTail <= keepHead || countWords(tokens.slice(keepHead, keepTail)) < FOLD_MIN_HIDDEN) {
      out.push(part);
      return;
    }
    const head = tokens.slice(0, keepHead).join('');
    const hidden = tokens.slice(keepHead, keepTail);
    const tail = tokens.slice(keepTail).join('');
    if (head) out.push({ kind: 'same', text: head });
    out.push({ kind: 'fold', text: hidden.join(''), words: countWords(hidden) });
    if (tail) out.push({ kind: 'same', text: tail });
  });
  return out;
}
