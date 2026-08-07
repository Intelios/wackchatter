import { describe, expect, test } from 'bun:test';
import type { RegexScript } from '@shared/types/regex.ts';
import { newRegexScript, REGEX_PLACEMENT } from '@shared/types/regex.ts';
import {
  addScript,
  duplicateScript,
  hasUsablePlacement,
  moveScript,
  nextScriptName,
  regexTarget,
  removeScript,
  targetFlags,
  togglePlacement,
  updateScript,
} from './regexScripts.ts';

const named = (id: string, scriptName: string): RegexScript => ({
  ...newRegexScript(id, scriptName),
});

describe('nextScriptName', () => {
  test('fills the lowest gap rather than counting the list', () => {
    const scripts = [named('a', 'Script 1'), named('c', 'Script 3')];
    expect(nextScriptName(scripts)).toBe('Script 2');
  });

  test('ignores names the user chose', () => {
    expect(nextScriptName([named('a', 'hide thinking')])).toBe('Script 1');
  });
});

describe('list edits', () => {
  test('add appends a display-only script, the safe default', () => {
    const [script] = addScript([], 'new');
    expect(script?.markdownOnly).toBe(true);
    expect(script?.promptOnly).toBe(false);
  });

  test('update patches one script and leaves the rest alone', () => {
    const scripts = [named('a', 'A'), named('b', 'B')];
    const next = updateScript(scripts, 'b', { findRegex: '/x/' });
    expect(next[1]?.findRegex).toBe('/x/');
    expect(next[0]).toEqual(scripts[0]!);
    expect(next).not.toBe(scripts);
  });

  test('remove drops only the named script', () => {
    expect(removeScript([named('a', 'A'), named('b', 'B')], 'a').map((s) => s.id)).toEqual(['b']);
  });

  test('duplicate lands directly below the original with its own id', () => {
    const next = duplicateScript([named('a', 'A'), named('b', 'B')], 'a', 'copy');
    expect(next.map((s) => s.id)).toEqual(['a', 'copy', 'b']);
    expect(next[1]?.scriptName).toBe('A copy');
  });

  test('duplicate copies the arrays rather than sharing them', () => {
    const original = { ...named('a', 'A'), placement: [1], trimStrings: ['x'] };
    const [, copy] = duplicateScript([original], 'a', 'copy');
    copy?.placement.push(2);
    expect(original.placement).toEqual([1]);
  });
});

describe('moveScript', () => {
  const scripts = [named('a', 'A'), named('b', 'B'), named('c', 'C')];

  test('swaps with the neighbour, because order is the chain order', () => {
    expect(moveScript(scripts, 'b', -1).map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(moveScript(scripts, 'b', 1).map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  test('is a no-op at either end', () => {
    expect(moveScript(scripts, 'a', -1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(moveScript(scripts, 'c', 1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the Affects control', () => {
  test('round-trips every combination of ST two booleans', () => {
    for (const target of ['display', 'prompt', 'both', 'store'] as const) {
      const script = { ...named('a', 'A'), ...targetFlags(target) };
      expect(regexTarget(script)).toBe(target);
    }
  });

  test('display only is the flag pair the user asked for', () => {
    // Hidden from the reader, still sent to the model.
    expect(targetFlags('display')).toEqual({ markdownOnly: true, promptOnly: false });
  });

  test('an imported destructive script reads as store, not as something else', () => {
    const imported = { ...named('a', 'A'), markdownOnly: false, promptOnly: false };
    expect(regexTarget(imported)).toBe('store');
  });
});

describe('placements', () => {
  test('toggling on adds and toggling off removes', () => {
    expect(togglePlacement([1], 2, true)).toEqual([1, 2]);
    expect(togglePlacement([1, 2], 1, false)).toEqual([2]);
  });

  test('toggling on twice does not duplicate', () => {
    expect(togglePlacement([1], 1, true)).toEqual([1]);
  });

  test('a value the editor does not offer survives every toggle', () => {
    // 4 is ST retired sendAs. Dropping it would corrupt the file on the next export.
    expect(togglePlacement([4], REGEX_PLACEMENT.USER_INPUT, true)).toEqual([4, 1]);
    expect(togglePlacement([4, 1], REGEX_PLACEMENT.USER_INPUT, false)).toEqual([4]);
  });

  test('a script with only an unsupported placement can never fire', () => {
    expect(hasUsablePlacement({ ...named('a', 'A'), placement: [4] })).toBe(false);
    expect(hasUsablePlacement({ ...named('a', 'A'), placement: [] })).toBe(false);
    expect(hasUsablePlacement(named('a', 'A'))).toBe(true);
  });
});
