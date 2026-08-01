/**
 * Keyword matching, replicating SillyTavern's `matchKeys` (world-info.js:334) exactly.
 *
 * "Exactly" includes two behaviours that look like bugs and are not being fixed here,
 * each with a named test below so nobody helpfully repairs them later:
 *
 *   1. A MULTI-WORD key silently skips whole-word matching and becomes a plain substring
 *      test. So the key `red dragon` matches inside `bored dragonfly`.
 *   2. The whole-word boundary regex uses `\W` with NO `u` flag, so `\W` means
 *      "not [A-Za-z0-9_]" — every Cyrillic, Greek, CJK or accented letter counts as a
 *      boundary. Non-Latin keys therefore lose whole-word matching in practice.
 *
 * Both are load-bearing: books were authored against them, and changing which entries
 * fire in somebody's existing library is a worse failure than an odd rule. Per-entry
 * `matchWholeWords` and regex keys are the escape hatches.
 */

import type { WiLogic, WorldInfoEntry } from '../types/worldinfo.ts';
import { WI_LOGIC } from '../types/worldinfo.ts';

/** ST's escapeRegex (utils.js:1378), character for character. */
function escapeRegex(value: string): string {
  return value.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * A `/pattern/flags` literal into a RegExp, or null if it isn't one.
 *
 * `g` and `y` are stripped. ST compiles a fresh regex on every single match call so it
 * never notices, but we cache compiled regexes per entry per run — and `.test()` on a
 * sticky or global regex advances `lastIndex`, so the second call against the same regex
 * would return false for a string that plainly matches. That bug is invisible until an
 * entry has two keys or two passes, which is why the flags come off here rather than at
 * the call site.
 */
export function parseRegexLiteral(input: string): RegExp | null {
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(input);
  if (!match) return null;

  const [, rawPattern = '', rawFlags = ''] = match;

  // An unescaped `/` inside the body means this isn't a well-formed literal in any other
  // engine, so ST refuses it and so do we — rather than quietly matching something else.
  if (/(^|[^\\])\//.test(rawPattern)) return null;

  // `\/` and `/` compile identically in JS, so this is cosmetic. ST does the same
  // replacement non-globally, which is a no-op difference.
  const pattern = rawPattern.replaceAll('\\/', '/');
  const flags = rawFlags.replace(/[gy]/g, '');

  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** Per-run compiled-regex cache, so a key is parsed once rather than once per pass. */
export type RegexCache = Map<string, RegExp | null>;

export function createRegexCache(): RegexCache {
  return new Map();
}

function compile(key: string, cache?: RegexCache): RegExp | null {
  if (!cache) return parseRegexLiteral(key);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const compiled = parseRegexLiteral(key);
  cache.set(key, compiled);
  return compiled;
}

/** The case and whole-word settings actually in force for one entry. */
export interface MatchSettings {
  caseSensitive: boolean;
  matchWholeWords: boolean;
}

/** Resolve an entry's `T | null` overrides against the global settings. null = inherit. */
export function matchSettingsFor(
  entry: Pick<WorldInfoEntry, 'caseSensitive' | 'matchWholeWords'>,
  globals: MatchSettings,
): MatchSettings {
  return {
    caseSensitive: entry.caseSensitive ?? globals.caseSensitive,
    matchWholeWords: entry.matchWholeWords ?? globals.matchWholeWords,
  };
}

/**
 * Does one key match the haystack?
 *
 * A regex key overrides everything — case sensitivity and whole-word both, and it tests
 * the RAW haystack rather than the case-folded one.
 */
export function matchKey(
  haystack: string,
  key: string,
  settings: MatchSettings,
  cache?: RegexCache,
): boolean {
  // ST trims every key and skips blank ones before matching. A blank key must never
  // match, or one stray comma in the editor would make an entry unconditionally active.
  const trimmed = key.trim();
  if (!trimmed) return false;

  const regex = compile(trimmed, cache);
  if (regex) return regex.test(haystack);

  const subject = settings.caseSensitive ? haystack : haystack.toLowerCase();
  const needle = settings.caseSensitive ? trimmed : trimmed.toLowerCase();

  if (!settings.matchWholeWords) return subject.includes(needle);

  // Quirk 1: more than one word and whole-word matching is abandoned entirely.
  if (needle.split(/\s+/).length > 1) return subject.includes(needle);

  // Quirk 2: no `u` flag, so `\W` is ASCII-only. Custom boundaries rather than `\b` so
  // that punctuation adjacent to a key still counts as a word break.
  return new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`).test(subject);
}

/** Does any key match? An empty list matches nothing. */
export function matchAny(
  haystack: string,
  keys: string[],
  settings: MatchSettings,
  cache?: RegexCache,
): boolean {
  return keys.some((key) => matchKey(haystack, key, settings, cache));
}

/**
 * The secondary-key gate, applied only when an entry is `selective` with secondary keys.
 *
 * Read the four modes as conditions on the SECONDARY keys, given the primary already hit:
 *   AND_ANY  at least one secondary present
 *   AND_ALL  every secondary present
 *   NOT_ANY  no secondary present
 *   NOT_ALL  not every secondary present (i.e. at least one missing)
 */
export function evaluateSecondary(
  haystack: string,
  keys: string[],
  logic: WiLogic,
  settings: MatchSettings,
  cache?: RegexCache,
): boolean {
  // No restriction. ST expresses this as a guard at the call site (world-info.js:4811)
  // rather than inside the logic, so with an empty list AND_ANY would return false there.
  // Keeping the guard in here means the caller cannot forget it.
  if (keys.length === 0) return true;

  const hits = keys.map((key) => matchKey(haystack, key, settings, cache));

  switch (logic) {
    case WI_LOGIC.AND_ANY:
      return hits.some(Boolean);
    case WI_LOGIC.AND_ALL:
      return hits.every(Boolean);
    case WI_LOGIC.NOT_ANY:
      return !hits.some(Boolean);
    case WI_LOGIC.NOT_ALL:
      return !hits.every(Boolean);
    default:
      return true;
  }
}
