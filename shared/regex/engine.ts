/**
 * Regex script execution, replicating SillyTavern's `regex/engine.js`.
 *
 * "Replicating" includes several behaviours that look like bugs and are not being fixed
 * here, each with a named test below so nobody helpfully repairs them later:
 *
 *   1. A BARE pattern gets no flags at all. `foo` replaces the first match only; you have
 *      to write `/foo/g` to replace every one. Every script anyone has ever shared assumes
 *      this, and quietly adding `g` would change what those scripts do.
 *   2. Invalid flags do not fail — the WHOLE original string, slashes included, becomes the
 *      pattern. `/foo/G` matches the literal text `/foo/G`.
 *   3. Only `$N` and `$<name>` are capture references. `$&`, `` $` ``, `$'` and `$$` pass
 *      through literally, because the replacement is a function rather than a string.
 *   4. A falsy capture becomes the empty string, so a group that matched `""` and a group
 *      that did not participate are indistinguishable.
 *   5. `trimStrings` apply to substituted capture values only, never to the literal text
 *      around them in the replacement.
 *   6. `sanitizeRegexMacro` escapes `/` but not `-` or `!`, so a substituted name inside a
 *      character class can still form a range.
 *
 * Two divergences are deliberate, each also with a named test:
 *
 *   1. `g`/`y` flags are KEPT, unlike `shared/worldinfo/match.ts`'s `parseRegexLiteral`,
 *      which strips them. Replacing every match is the entire point of `g` here. Compiled
 *      regexes are cached, so `lastIndex` is reset before every use.
 *   2. A literal newline inside a pattern is preserved. ST's parser is unanchored with a
 *      dot that does not cross newlines, so `/foo\nbar/` silently compiles to `/\/foo/` —
 *      behaviour nobody could explain while staring at the editor's live tester.
 *
 * The module is a leaf: macro expansion is injected, not imported, so the prompt path can
 * pass assembly's runtime-carrying closure (where a `{{setvar}}` in a replacement really
 * does write a chat variable, as in ST) while the display path passes a disposable one
 * (where rendering can never mutate state).
 */

import type { RegexScript } from '../types/regex.ts';
import { REGEX_SUBSTITUTE } from '../types/regex.ts';

/**
 * Macro expansion for text the SCRIPT author wrote — the find pattern, the trim strings
 * and the replacement. Never for the message being transformed; that has already been
 * through the macro engine by the time it reaches us.
 */
export interface RegexMacros {
  expand(text: string, source: string): string;
  /** Expand, escaping each resolved value so a name full of metacharacters stays inert. */
  expandEscaped(text: string, source: string): string;
}

export interface RegexContext {
  /** A `REGEX_PLACEMENT` value. Anything a script does not list simply never fires. */
  placement: number;
  /** ST's `isMarkdown`: this text is on its way to the transcript. */
  display?: boolean;
  /** ST's `isPrompt`: this text is on its way to the model. */
  prompt?: boolean;
  /** Distance from the end of the transcript, 0 = last. Undefined skips depth gating. */
  depth?: number;
}

export interface RegexRunOptions {
  macros?: RegexMacros;
  cache?: RegexCompileCache;
}

/** Compiled-regex cache, so one pattern is parsed once per run rather than once per message. */
export type RegexCompileCache = Map<string, RegExp | null>;

export function createRegexCompileCache(): RegexCompileCache {
  return new Map();
}

/**
 * ST's flag validator (utils.js:1390): a non-repeating subset of these letters. `x`, `X`,
 * `U`, `A` and `J` pass here and are then rejected by the RegExp constructor, which is how
 * ST ends up returning nothing for them. We reach the same outcome by the same route.
 */
const VALID_FLAGS = /^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/;

/**
 * A find pattern into a RegExp, or null if it cannot compile.
 *
 * Note the missing end anchor: ST's parser is unanchored, so `/foo/g1` compiles as `foo`
 * with flag `g` and the stray `1` is dropped. Reproduced, because a script written against
 * that behaviour should not start failing here.
 */
export function compileFindRegex(input: string, cache?: RegexCompileCache): RegExp | null {
  if (cache) {
    const cached = cache.get(input);
    if (cached !== undefined) return cached;
  }
  const compiled = compile(input);
  cache?.set(input, compiled);
  return compiled;
}

function compile(input: string): RegExp | null {
  // An empty pattern is "not written yet", not "matches everything". ST never reaches the
  // question because its parser throws on an empty string and the throw is swallowed.
  if (!input) return null;

  // `(.+)` rather than `(.*)`, so `//` falls through to the bare branch and compiles to a
  // pattern matching two literal slashes — which is what ST does with it.
  const slashed = /^\/(.+)\/([a-zA-Z]*)/s.exec(input);

  try {
    if (slashed) {
      const [, pattern = '', flags = ''] = slashed;
      // Not an error: the whole original string, slashes and all, becomes the pattern.
      if (flags && !VALID_FLAGS.test(flags)) return new RegExp(input);
      return new RegExp(pattern, flags);
    }
    return new RegExp(input);
  } catch {
    return null;
  }
}

/**
 * ST's `sanitizeRegexMacro` (regex/engine.js:303), character for character.
 *
 * The set omits `-` and `!` and includes `/`. The `/` is there because a slash would end
 * the literal in `compileFindRegex`; the two omissions are simply an oversight, and one
 * that a substituted name inside a character class can still trip over.
 */
export function sanitizeRegexMacro(value: string): string {
  return value.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (char) => {
    switch (char) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\v':
        return '\\v';
      case '\f':
        return '\\f';
      case '\0':
        return '\\0';
      default:
        return `\\${char}`;
    }
  });
}

/**
 * Whether a script runs in this context — ST's gate (regex/engine.js:347), in ST's order:
 * ephemerality first, then depth, then placement.
 */
export function scriptApplies(script: RegexScript, context: RegexContext): boolean {
  if (script.disabled) return false;

  const { display = false, prompt = false } = context;
  const runs =
    (script.markdownOnly && display) ||
    (script.promptOnly && prompt) ||
    // ST's destructive default, which rewrites the chat file. We have no storage-path call
    // site, so `display` and `prompt` are never both false and this arm never fires — the
    // script is inert by construction rather than by a special case. It is written out in
    // full anyway, so that adding such a path later cannot silently change what runs.
    (!script.markdownOnly && !script.promptOnly && !display && !prompt);
  if (!runs) return false;

  if (typeof context.depth === 'number') {
    // Both bounds INCLUSIVE. null means unlimited, and so does a bound below its own floor
    // — ST treats `minDepth < -1` and `maxDepth < 0` as unset rather than as impossible,
    // which is the difference between an out-of-range box disabling a script and being
    // ignored.
    const { minDepth, maxDepth } = script;
    if (
      minDepth !== null &&
      Number.isFinite(minDepth) &&
      minDepth >= -1 &&
      context.depth < minDepth
    )
      return false;
    if (maxDepth !== null && Number.isFinite(maxDepth) && maxDepth >= 0 && context.depth > maxDepth)
      return false;
  }

  return script.placement.includes(context.placement);
}

/**
 * Run one script, with no gating at all — not even `disabled`.
 *
 * That is deliberate and is why this is separate from `applyRegexScripts`: the editor's
 * live tester previews the script you are looking at, and refusing to preview one you had
 * switched off would be an odd way to explain what it does. Every real call site goes
 * through `applyRegexScripts`, which gates.
 */
export function runRegexScript(
  script: RegexScript,
  input: string,
  options: RegexRunOptions = {},
): string {
  if (!script.findRegex || !input) return input;

  const { macros, cache } = options;
  const findRegex = compileFindRegex(findPattern(script, macros), cache);
  if (!findRegex) return input;

  // Cached regexes outlive one call, and `lastIndex` on a `g`/`y` regex does not always
  // come back to 0 on its own. The same trap `parseRegexLiteral` sidesteps by stripping
  // the flags, which is not an option when the whole job is replacing.
  findRegex.lastIndex = 0;

  // `{{match}}` becomes the literal text `$0`, which the capture scan below then resolves
  // to the whole match. Two steps, as in ST — `$0` is not special to `String.replace`, so
  // it survives the first pass intact.
  const template = script.replaceString.replace(/\{\{match\}\}/gi, '$0');

  return input.replace(findRegex, (...args: unknown[]) => {
    // `groups` is appended only when the pattern declares named groups; otherwise the last
    // argument is the whole input string, which the object check rejects.
    const tail = args.at(-1);
    const groups =
      typeof tail === 'object' && tail !== null
        ? (tail as Record<string, string | undefined>)
        : undefined;

    const filled = template.replaceAll(
      /\$(\d+)|\$<([^>]+)>/g,
      (_token: string, num?: string, name?: string) => {
        const value = num !== undefined ? args[Number(num)] : name ? groups?.[name] : undefined;
        // Not a string means the reference points past the last capture group, where the
        // callback's trailing offset/input arguments live. ST splices those in — `$1` on a
        // pattern with no groups yields the match offset — which is a bug rather than a
        // behaviour anyone wrote a script against, so a missing group yields nothing here.
        // Falsy is ST's own rule and is kept: an unmatched optional group vanishes.
        if (typeof value !== 'string' || !value) return '';
        return trimAway(value, script.trimStrings, macros);
      },
    );

    // Macros expand LAST, over the assembled replacement, so a capture that happens to
    // contain `{{...}}` is expanded too. ST's ordering.
    return macros ? macros.expand(filled, `regex:${script.id}`) : filled;
  });
}

/**
 * Every script that applies, chained — each one's output is the next one's input.
 *
 * The chain is why list order is meaningful and why the editor offers move up/down: the
 * shared `[Name]: ` scripts add a prefix and then a later script strips it from the
 * display, which only works in that order.
 */
export function applyRegexScripts(
  input: string,
  scripts: readonly RegexScript[],
  context: RegexContext,
  options: RegexRunOptions = {},
): string {
  if (!input || scripts.length === 0) return input;

  let result = input;
  for (const script of scripts) {
    if (!scriptApplies(script, context)) continue;
    result = runRegexScript(script, result, options);
  }
  return result;
}

/** The find pattern with macros expanded per the script's `substituteRegex` mode. */
function findPattern(script: RegexScript, macros?: RegexMacros): string {
  if (!macros) return script.findRegex;
  const source = `regex:find:${script.id}`;
  switch (script.substituteRegex) {
    case REGEX_SUBSTITUTE.RAW:
      return macros.expand(script.findRegex, source);
    case REGEX_SUBSTITUTE.ESCAPED:
      return macros.expandEscaped(script.findRegex, source);
    default:
      return script.findRegex;
  }
}

/** ST's `filterString`: literal `replaceAll` per trim string, macros expanded first. */
function trimAway(value: string, trimStrings: string[], macros?: RegexMacros): string {
  let result = value;
  for (const trim of trimStrings) {
    const expanded = macros ? macros.expand(trim, 'regex:trim') : trim;
    // `replaceAll('')` splices the replacement between every character. Unreachable from
    // the editor, which drops blank lines, but a macro that resolves to nothing gets here.
    if (!expanded) continue;
    result = result.replaceAll(expanded, '');
  }
  return result;
}
