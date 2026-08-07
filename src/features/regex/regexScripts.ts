/**
 * Regex script list edits, and the translation between SillyTavern's two ephemerality
 * booleans and the single control the editor shows.
 *
 * Pure and separate from the component for the same reason `quickCommands.ts` is: there is
 * no DOM harness in this project, so the logic worth testing has to live somewhere a test
 * can reach it.
 *
 * Every function returns a new array. The settings patch replaces the list wholesale, so an
 * in-place edit would neither persist nor re-render.
 */

import type { RegexScript } from '@shared/types/regex.ts';
import { newRegexScript, REGEX_PLACEMENT } from '@shared/types/regex.ts';

/** The lowest free `Script N`, so deleting the middle one and adding does not collide. */
export function nextScriptName(scripts: readonly RegexScript[]): string {
  const taken = new Set(
    scripts
      .map((script) => /^Script (\d+)$/.exec(script.scriptName)?.[1])
      .filter((n): n is string => n !== undefined),
  );

  let n = 1;
  while (taken.has(String(n))) n += 1;
  return `Script ${n}`;
}

export function addScript(scripts: readonly RegexScript[], id: string): RegexScript[] {
  return [...scripts, newRegexScript(id, nextScriptName(scripts))];
}

export function updateScript(
  scripts: readonly RegexScript[],
  id: string,
  patch: Partial<Omit<RegexScript, 'id'>>,
): RegexScript[] {
  return scripts.map((script) => (script.id === id ? { ...script, ...patch } : script));
}

export function removeScript(scripts: readonly RegexScript[], id: string): RegexScript[] {
  return scripts.filter((script) => script.id !== id);
}

/** A copy, placed directly below its original so the chain order stays obvious. */
export function duplicateScript(
  scripts: readonly RegexScript[],
  id: string,
  newId: string,
): RegexScript[] {
  const index = scripts.findIndex((script) => script.id === id);
  if (index === -1) return [...scripts];

  const original = scripts[index]!;
  const copy: RegexScript = {
    ...original,
    id: newId,
    scriptName: `${original.scriptName} copy`,
    trimStrings: [...original.trimStrings],
    placement: [...original.placement],
  };
  return [...scripts.slice(0, index + 1), copy, ...scripts.slice(index + 1)];
}

/**
 * Move one script up or down.
 *
 * Order is not cosmetic here: scripts chain, so each one's output is the next one's input.
 * The shared speaker-tag pair only works because the script that adds `[Name]: ` runs
 * before the one that strips it from the display.
 */
export function moveScript(
  scripts: readonly RegexScript[],
  id: string,
  direction: -1 | 1,
): RegexScript[] {
  const index = scripts.findIndex((script) => script.id === id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= scripts.length) return [...scripts];

  const next = [...scripts];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/**
 * What a script affects, as one value.
 *
 * SillyTavern spends two booleans named `markdownOnly` and `promptOnly` on this, and
 * reading them as "only" flags is exactly backwards — they mean "runs during". The pair is
 * the file format and is stored untouched; this is what the editor shows instead.
 */
export type RegexTarget = 'display' | 'prompt' | 'both' | 'store';

export function regexTarget(script: RegexScript): RegexTarget {
  if (script.markdownOnly && script.promptOnly) return 'both';
  if (script.markdownOnly) return 'display';
  if (script.promptOnly) return 'prompt';
  return 'store';
}

/** The flag pair for a target. Round-trips, so an exported file stays ST-compatible. */
export function targetFlags(target: RegexTarget): Pick<RegexScript, 'markdownOnly' | 'promptOnly'> {
  return {
    markdownOnly: target === 'display' || target === 'both',
    promptOnly: target === 'prompt' || target === 'both',
  };
}

export const TARGET_OPTIONS: ReadonlyArray<{ label: string; value: RegexTarget }> = [
  { label: 'Display only — hidden from you, still sent to the AI', value: 'display' },
  { label: 'Prompt only — you still see it, the AI does not', value: 'prompt' },
  { label: 'Both — display and prompt', value: 'both' },
  // Present so an imported ST script does not silently become something else. Selecting it
  // is honest: with no storage-path call site, such a script really does nothing here.
  { label: 'Rewrite stored text (not supported)', value: 'store' },
];

/** The short label on a collapsed row. */
export function targetLabel(target: RegexTarget): string {
  switch (target) {
    case 'display':
      return 'Display';
    case 'prompt':
      return 'Prompt';
    case 'both':
      return 'Both';
    default:
      return 'Inactive';
  }
}

/** Placements the editor offers, in the order they are shown. */
export const PLACEMENT_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'Your messages', value: REGEX_PLACEMENT.USER_INPUT },
  { label: 'Replies', value: REGEX_PLACEMENT.AI_OUTPUT },
  { label: 'Reasoning', value: REGEX_PLACEMENT.REASONING },
];

/** Toggle one placement, leaving any value we do not offer — an imported 0, 3 or 4 — alone. */
export function togglePlacement(
  placement: readonly number[],
  value: number,
  on: boolean,
): number[] {
  if (on) return placement.includes(value) ? [...placement] : [...placement, value];
  return placement.filter((entry) => entry !== value);
}

/** A script with no placement can never fire, which is worth saying out loud in the UI. */
export function hasUsablePlacement(script: RegexScript): boolean {
  return PLACEMENT_OPTIONS.some((option) => script.placement.includes(option.value));
}
