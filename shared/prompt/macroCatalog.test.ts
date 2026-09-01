import { describe, expect, test } from 'bun:test';
import { findMacro, MACRO_CATALOG, searchMacros } from './macroCatalog.ts';
import {
  createMacroRuntime,
  KNOWN_MACROS,
  type MacroEnvironment,
  substituteMacros,
} from './macros.ts';

const env: MacroEnvironment = {
  char: 'Sera',
  user: 'Jack',
  description: 'A guardian.',
  maxContext: 8192,
  maxResponse: 512,
  model: 'test-model',
};

/*
 * The two directions the reference can be wrong in, each pinned once.
 *
 * Documentation that drifts is worse than none: a completion box offering a macro the
 * engine does not have teaches a typo, and one missing a macro means the feature exists
 * for nobody.
 */
describe('the catalogue and the engine agree', () => {
  test('every documented usage actually resolves', () => {
    for (const macro of MACRO_CATALOG) {
      const runtime = createMacroRuntime();
      substituteMacros(macro.usage, env, 'seed', { runtime, source: 'catalogue' });
      expect(runtime.warnings.map((warning) => warning.macro)).toEqual([]);
    }
  });

  test('every macro the engine knows is documented', () => {
    const documented = new Set(
      MACRO_CATALOG.flatMap((macro) => [macro.name, ...(macro.aliases ?? [])]),
    );
    const missing = KNOWN_MACROS.filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });

  test('names are canonical, lowercase and unique', () => {
    const seen = new Set<string>();
    for (const macro of MACRO_CATALOG) {
      for (const name of [macro.name, ...(macro.aliases ?? [])]) {
        expect(name).toBe(name.toLowerCase());
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
  });

  // The completion box inserts `usage` verbatim, so a malformed one lands as literal text.
  test('every usage is a single macro', () => {
    for (const macro of MACRO_CATALOG) {
      expect(macro.usage.startsWith('{{')).toBe(true);
      expect(macro.usage.endsWith('}}')).toBe(true);
      expect(macro.usage.match(/\{\{/g)).toHaveLength(1);
    }
  });
});

describe('lookup', () => {
  test('finds a macro by an alias, case-insensitively', () => {
    expect(findMacro('mesExamplesRaw')?.name).toBe('mesexamples');
    expect(findMacro('BOT')?.name).toBe('char');
  });

  test('an unknown name finds nothing', () => {
    expect(findMacro('notARealMacro')).toBeUndefined();
  });
});

describe('search', () => {
  test('prefix matches come first', () => {
    expect(searchMacros('ro')[0]?.name).toBe('roll');
  });

  test('an empty query lists everything', () => {
    expect(searchMacros('  ')).toHaveLength(MACRO_CATALOG.length);
  });

  test('a query matching nothing returns nothing', () => {
    expect(searchMacros('zzz')).toEqual([]);
  });
});
