/**
 * The `{{` completion box's recognition rules, with no DOM in reach.
 *
 * Separated from the component for the same reason `slashCommands.ts` is separated from the
 * composer: there is no DOM harness in this project, so the part worth testing has to be
 * reachable from a unit test. Everything here is a function of the text and the caret.
 *
 * The one rule that matters: the box is open while a macro NAME is being typed and closes
 * the moment the name is settled. `{{ro` is a question the box can answer; `{{roll::1d` is
 * not, and leaving it open there would put a listbox over the transcript while somebody
 * writes a dice formula.
 */

import { type MacroDoc, searchMacros } from '@shared/prompt/macroCatalog.ts';

export interface MacroCompletion {
  /** Index of the opening `{{`. */
  start: number;
  /** The caret. `[start, end)` is the range a completion replaces. */
  end: number;
  /** The half-typed name, lowercased and with any leading space dropped. */
  query: string;
  suggestions: MacroDoc[];
}

export function macroCompletion(text: string, caret: number): MacroCompletion | null {
  const end = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, end);
  const start = before.lastIndexOf('{{');
  if (start === -1) return null;

  const segment = before.slice(start + 2);
  // A closing brace, a second opener, or a line break: no longer inside that macro. A
  // macro is a single-line thing, so a newline ends the context even without a `}}`.
  if (/[{}\n]/.test(segment)) return null;

  // Leading whitespace is legal — the engine trims `{{ char }}` — but whitespace or a colon
  // AFTER the name means arguments have begun and there is nothing left to complete.
  const query = segment.trimStart().toLowerCase();
  if (/[\s:]/.test(query)) return null;

  const suggestions = searchMacros(query);
  if (suggestions.length === 0) return null;

  return { start, end, query, suggestions };
}

export interface MacroInsertion {
  text: string;
  /** Where the caret should land — inside the arguments, when there are any. */
  caret: number;
}

/**
 * What accepting a suggestion types for you.
 *
 * A macro that takes arguments is inserted as a skeleton rather than as its documented
 * example: `{{roll::}}` with the caret between the separators, not `{{roll::1d20}}` with a
 * sample somebody has to notice and delete.
 */
export function macroInsertion(
  text: string,
  completion: MacroCompletion,
  macro: MacroDoc,
): MacroInsertion {
  const template =
    macro.insert ?? (macro.takesArgs ? macro.usage.replace(/::.*\}\}$/, '::}}') : macro.usage);
  const caretInTemplate = macro.takesArgs ? template.indexOf('}}') : template.length;

  const head = text.slice(0, completion.start);
  // `end`, not a length derived from the query: the query is trimmed and lowercased, so
  // `{{ Ch` would leave a stray space behind if the range were reconstructed from it.
  const tail = text.slice(completion.end);
  return { text: `${head}${template}${tail}`, caret: head.length + caretInTemplate };
}
