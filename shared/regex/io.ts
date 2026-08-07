/**
 * Reading and writing regex scripts in SillyTavern's format.
 *
 * A script file is a shareable artifact — people post them, and they have to survive the
 * round trip in both directions. So the serialiser reproduces ST's exact output (its
 * thirteen keys, in its order, four-space indented) and the reader accepts both shapes ST
 * writes: a bare object from "export script", an array from "export all".
 *
 * Unlike cards and presets, unknown keys are NOT preserved. ST rebuilds a script from a
 * fixed field list on every save (index.js:848), so a key we invented would be dropped the
 * first time the file was opened there. Keeping it would promise a durability the format
 * does not have.
 */

import type { RegexScript, RegexSubstituteMode } from '../types/regex.ts';
import { REGEX_SUBSTITUTE } from '../types/regex.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * A depth bound. `null`, absent and NaN all mean unlimited.
 *
 * NaN is not hypothetical: ST holds a blank depth box as NaN in memory, and `JSON.stringify`
 * writes NaN as `null` — so every ST export of a script with unset depths says `null`, and
 * anything that round-tripped through a different serialiser may not.
 */
function depth(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function substituteMode(value: unknown): RegexSubstituteMode {
  const mode = Number(value);
  return mode === REGEX_SUBSTITUTE.RAW || mode === REGEX_SUBSTITUTE.ESCAPED
    ? mode
    : REGEX_SUBSTITUTE.NONE;
}

/**
 * Coerce one stored or imported script. Never rejects — a half-written script mid-edit is
 * still a script, and dropping one because its name box is momentarily empty would delete
 * the user's work on the next autosave. `parseRegexScriptFile` is where import applies the
 * stricter rule.
 *
 * The id is caller-supplied: import mints a fresh one, because two people's exports would
 * otherwise collide, while the settings normaliser keeps the one already stored.
 */
export function normalizeRegexScript(raw: unknown, id: string): RegexScript {
  const source = isRecord(raw) ? raw : {};

  return {
    id,
    scriptName: typeof source.scriptName === 'string' ? source.scriptName : '',
    // Stored verbatim even when it cannot compile. The user is mid-typing on every
    // keystroke, and ST's contract is that a bad pattern does nothing rather than
    // disappearing — a script that vanished as you typed `/[` would be unusable.
    findRegex: typeof source.findRegex === 'string' ? source.findRegex : '',
    replaceString: typeof source.replaceString === 'string' ? source.replaceString : '',
    trimStrings: Array.isArray(source.trimStrings)
      ? source.trimStrings.filter((entry): entry is string => typeof entry === 'string')
      : [],
    // Unknown placement values are kept, not filtered: an ST script may carry 0, 3 or 4,
    // and dropping them here would corrupt the file the next time it was exported. One we
    // do not fire simply never matches.
    placement: Array.isArray(source.placement)
      ? source.placement.filter(
          (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
        )
      : [],
    disabled: bool(source.disabled, false),
    markdownOnly: bool(source.markdownOnly, false),
    promptOnly: bool(source.promptOnly, false),
    runOnEdit: bool(source.runOnEdit, true),
    substituteRegex: substituteMode(source.substituteRegex),
    minDepth: depth(source.minDepth),
    maxDepth: depth(source.maxDepth),
  };
}

/**
 * Read an exported file. ST writes a bare object for one script and an array for all of
 * them; both are accepted, and anything without a `scriptName` is rejected as not being a
 * regex script at all — ST's own import check, and the only field that distinguishes one
 * from arbitrary JSON.
 */
export function parseRegexScriptFile(raw: unknown, mintId: () => string): RegexScript[] {
  const entries = Array.isArray(raw) ? raw : [raw];
  const scripts: RegexScript[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (typeof entry.scriptName !== 'string' || !entry.scriptName.trim()) continue;
    scripts.push(normalizeRegexScript(entry, mintId()));
  }

  return scripts;
}

/** ST's on-disk shape: four-space indent, no trailing newline, its key order. */
export function serializeRegexScript(script: RegexScript): string {
  return JSON.stringify(script, null, 4);
}

export function serializeRegexScripts(scripts: readonly RegexScript[]): string {
  return JSON.stringify(scripts, null, 4);
}

/** Characters ST replaces in a script name before using it as a filename. */
const FILENAME_UNSAFE = /[\s.<>:"/\\|?*]/;

/**
 * ST's `sanitizeFileName` (regex/index.js:19) — whitespace, dots and everything Windows
 * forbids become underscores. Hyphens survive, which is why the shared scripts are called
 * `regex-usercharhide.json`.
 *
 * Control characters are tested by codepoint rather than by a regex range, so this source
 * file stays free of literal control bytes.
 */
export function regexScriptFilename(script: RegexScript): string {
  const name = Array.from(script.scriptName, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return FILENAME_UNSAFE.test(char) || code < 0x20 || code === 0x7f ? '_' : char;
  })
    .join('')
    .toLowerCase();
  return `regex-${name || 'script'}.json`;
}
