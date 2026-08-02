import { describe, expect, test } from 'bun:test';
import type { AppSettings } from '../../shared/types/settings.ts';
import {
  DEFAULT_DIALOGUE_COLORS,
  DEFAULT_GUIDANCE,
  DEFAULT_SETTINGS,
} from '../../shared/types/settings.ts';
import { DEFAULT_WI_SETTINGS } from '../../shared/types/worldinfo.ts';
import {
  mergeSettings,
  reassignCharacterDialogueColor,
  reassignGlobalLorebooks,
  removePersonaDialogueColor,
} from './settings.ts';

function base(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

describe('mergeSettings', () => {
  test('a partial worldInfo patch keeps every untouched field', () => {
    // The bug a shallow spread would cause: changing the scan depth in the UI silently
    // resets the budget, recursion and both match settings.
    const next = mergeSettings(base(), { worldInfo: { depth: 7 } as never });

    expect(next.worldInfo.depth).toBe(7);
    expect(next.worldInfo.budget).toBe(DEFAULT_WI_SETTINGS.budget);
    expect(next.worldInfo.recursive).toBe(DEFAULT_WI_SETTINGS.recursive);
    expect(next.worldInfo.matchWholeWords).toBe(DEFAULT_WI_SETTINGS.matchWholeWords);
  });

  test('false is a real value, not an absence', () => {
    const next = mergeSettings(base(), { worldInfo: { recursive: false } as never });
    expect(next.worldInfo.recursive).toBe(false);
  });

  test('zero is a real value, so a cap can be cleared', () => {
    const capped = mergeSettings(base(), { worldInfo: { budgetCap: 500 } as never });
    expect(
      mergeSettings(capped, { worldInfo: { budgetCap: 0 } as never }).worldInfo.budgetCap,
    ).toBe(0);
  });

  test('a wrong-typed field falls back to its default rather than poisoning the file', () => {
    const next = mergeSettings(base(), { worldInfo: { depth: 'lots' } as never });
    expect(next.worldInfo.depth).toBe(DEFAULT_WI_SETTINGS.depth);
  });

  test('omitting worldInfo leaves it untouched', () => {
    const current = mergeSettings(base(), { worldInfo: { depth: 9 } as never });
    expect(mergeSettings(current, { streamingFps: 15 }).worldInfo.depth).toBe(9);
  });

  test('a partial connection patch keeps the rest of the connection', () => {
    const current = mergeSettings(base(), {
      connection: { provider: 'openrouter', baseUrl: 'https://x/api', model: 'a/b' },
    });
    const next = mergeSettings(current, { connection: { model: 'c/d' } as never });

    expect(next.connection.model).toBe('c/d');
    expect(next.connection.baseUrl).toBe('https://x/api');
    expect(next.connection.provider).toBe('openrouter');
  });

  test('unknown keys survive, so a newer build cannot be downgraded into data loss', () => {
    const current = { ...base(), futureKey: 'kept' };
    expect(mergeSettings(current, { streamingFps: 60 }).futureKey).toBe('kept');
  });

  test('personaId can be set and cleared', () => {
    const set = mergeSettings(base(), { personaId: 'abc' });
    expect(set.personaId).toBe('abc');
    expect(mergeSettings(set, { personaId: null }).personaId).toBeNull();
  });

  test('global variables replace atomically and discard unsupported values', () => {
    const current = mergeSettings(base(), { variables: { kept: 1, removed: 'old' } });
    const next = mergeSettings(current, {
      variables: { text: 'yes', number: 3, bad: { nested: true } } as never,
    });

    expect(next.variables).toEqual({ text: 'yes', number: 3 });
  });

  test('an empty global-variable map clears all globals', () => {
    const current = mergeSettings(base(), { variables: { score: 10 } });
    expect(mergeSettings(current, { variables: {} }).variables).toEqual({});
  });

  test('a partial guidance patch keeps every untouched field', () => {
    const next = mergeSettings(base(), { guidance: { template: 'Do: {{input}}' } as never });

    expect(next.guidance.template).toBe('Do: {{input}}');
    expect(next.guidance.role).toBe(DEFAULT_GUIDANCE.role);
    expect(next.guidance.guideDepth).toBe(DEFAULT_GUIDANCE.guideDepth);
    expect(next.guidance.guideRole).toBe(DEFAULT_GUIDANCE.guideRole);
  });

  test('guidance depth zero survives, because zero is where guidance belongs', () => {
    // The default already is 0, so set it away and back — a truthiness guard would pass
    // the first assertion and fail this one.
    const moved = mergeSettings(base(), { guidance: { depth: 4 } as never });
    expect(moved.guidance.depth).toBe(4);
    expect(mergeSettings(moved, { guidance: { depth: 0 } as never }).guidance.depth).toBe(0);
  });

  test('an unknown injection role falls back rather than reaching the provider', () => {
    // Roles are a union, so a typeof check would wave any string through and the request
    // would 400 at the provider with nothing pointing back here.
    const next = mergeSettings(base(), { guidance: { role: 'narrator' } as never });
    expect(next.guidance.role).toBe(DEFAULT_GUIDANCE.role);
  });

  test('omitting guidance leaves it untouched', () => {
    const current = mergeSettings(base(), { guidance: { guideDepth: 3 } as never });
    expect(mergeSettings(current, { streamingFps: 15 }).guidance.guideDepth).toBe(3);
  });

  test('dialogue colours default on and a partial patch keeps both override maps', () => {
    const current = mergeSettings(base(), {
      dialogueColors: {
        enabled: true,
        characters: { 'Alice.png': '#AABBCC' },
        personas: { jack: null },
      },
    });
    const next = mergeSettings(current, { dialogueColors: { enabled: false } as never });

    expect(next.dialogueColors.enabled).toBeFalse();
    expect(next.dialogueColors.characters).toEqual({ 'Alice.png': '#aabbcc' });
    expect(next.dialogueColors.personas).toEqual({ jack: null });
  });

  test('dialogue colour maps replace independently and discard malformed values', () => {
    const current = mergeSettings(base(), {
      dialogueColors: {
        ...DEFAULT_DIALOGUE_COLORS,
        characters: { kept: '#123456' },
        personas: { old: '#abcdef' },
      },
    });
    const next = mergeSettings(current, {
      dialogueColors: {
        characters: { good: '#ABCDEF', off: null, bad: 'red' },
      } as never,
    });

    expect(next.dialogueColors.characters).toEqual({ good: '#abcdef', off: null });
    expect(next.dialogueColors.personas).toEqual({ old: '#abcdef' });
  });
});

describe('dialogue colour identity changes', () => {
  test('a character rename re-keys its override without disturbing the rest', () => {
    const current = mergeSettings(base(), {
      dialogueColors: {
        enabled: true,
        characters: { 'Old.png': '#123456', 'Other.png': null },
        personas: {},
      },
    });
    const next = reassignCharacterDialogueColor(current, 'Old.png', 'New.png');

    expect(next?.dialogueColors.characters).toEqual({
      'New.png': '#123456',
      'Other.png': null,
    });
    expect(reassignCharacterDialogueColor(current, 'Missing.png', 'New.png')).toBeNull();
  });

  test('deleting a character or persona removes only its override', () => {
    const current = mergeSettings(base(), {
      dialogueColors: {
        enabled: true,
        characters: { doomed: null, kept: '#123456' },
        personas: { doomed: '#abcdef', kept: null },
      },
    });

    expect(
      reassignCharacterDialogueColor(current, 'doomed', null)?.dialogueColors.characters,
    ).toEqual({
      kept: '#123456',
    });
    expect(removePersonaDialogueColor(current, 'doomed')?.dialogueColors.personas).toEqual({
      kept: null,
    });
  });
});

describe('reassignGlobalLorebooks', () => {
  function withGlobals(ids: string[]): AppSettings {
    return { ...base(), globalLorebooks: ids };
  }

  test('a rename repoints the selection, keeping order and the rest', () => {
    const next = reassignGlobalLorebooks(withGlobals(['a', 'old', 'b']), 'old', 'new');
    expect(next?.globalLorebooks).toEqual(['a', 'new', 'b']);
  });

  test('a delete drops the entry', () => {
    const next = reassignGlobalLorebooks(withGlobals(['a', 'old', 'b']), 'old', null);
    expect(next?.globalLorebooks).toEqual(['a', 'b']);
  });

  test('nothing referencing the old id means nothing to persist', () => {
    expect(reassignGlobalLorebooks(withGlobals(['a', 'b']), 'old', 'new')).toBeNull();
  });

  test('an absent or malformed selection is left alone', () => {
    expect(reassignGlobalLorebooks(base(), 'old', 'new')).toBeNull();
    expect(
      reassignGlobalLorebooks({ ...base(), globalLorebooks: 'nope' }, 'old', 'new'),
    ).toBeNull();
  });
});
