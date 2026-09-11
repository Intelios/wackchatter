import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GROUP_COMPOSER_LAYOUT,
  DEFAULT_SINGLE_COMPOSER_LAYOUT,
} from '../../shared/composer/layout.ts';
import type { Connection } from '../../shared/providers/types.ts';
import type { AppSettings } from '../../shared/types/settings.ts';
import {
  DEFAULT_COCREATOR,
  DEFAULT_CONNECTION_ID,
  DEFAULT_DIALOGUE_COLORS,
  DEFAULT_GUIDANCE,
  DEFAULT_MEMORY,
  DEFAULT_SETTINGS,
  DEFAULT_SUMMARY,
  MAX_RECENT_PERSONAS,
} from '../../shared/types/settings.ts';
import { DEFAULT_WI_SETTINGS } from '../../shared/types/worldinfo.ts';
import { DEFAULT_DATA_DIR, PATHS, setDataDir } from './paths.ts';
import { getApiKey } from './secrets.ts';
import {
  applyConnectionPatch,
  dropConnection,
  getSettings,
  MIGRATION_CONNECTION_ID,
  mergeSettings,
  migrateLegacyConnection,
  nextConnectionName,
  reassignArenaCardPool,
  reassignCharacterDialogueColor,
  reassignCharacterExampleSets,
  reassignCharacterRating,
  reassignGlobalLorebooks,
  removePersonaDialogueColor,
  resetSettingsCache,
  sameEndpoint,
} from './settings.ts';

function connection(id: string, name: string, overrides?: Partial<Connection>): Connection {
  return {
    id,
    name,
    provider: 'custom',
    baseUrl: `http://${id}`,
    model: '',
    showReasoning: true,
    ...overrides,
  };
}

function base(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

describe('mergeSettings', () => {
  test('composer layouts update independently and preserve required controls', () => {
    const single = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    single.rows[0]!.centre.push(single.rows[0]!.right.splice(0, 1)[0]!);
    const next = mergeSettings(base(), {
      composerLayouts: { single, group: DEFAULT_GROUP_COMPOSER_LAYOUT },
    });
    expect(next.composerLayouts.single).toEqual(single);
    expect(next.composerLayouts.group).toEqual(DEFAULT_GROUP_COMPOSER_LAYOUT);
  });

  test('a malformed composer layout cannot wipe a saved layout', () => {
    const current = base();
    const next = mergeSettings(current, {
      composerLayouts: { single: { rows: [] }, group: current.composerLayouts.group } as never,
    });
    expect(next.composerLayouts.single).toEqual(current.composerLayouts.single);
  });

  test('deleting a quick command removes its pinned composer shortcut', () => {
    const current = base();
    current.quickCommands = [
      { id: 'kept', name: 'Kept', text: 'a' },
      { id: 'gone', name: 'Gone', text: 'b' },
    ];
    current.composerLayouts.single.rows[0]!.centre = [
      { id: 'quick:kept', display: 'label' },
      { id: 'quick:gone', display: 'icon' },
    ];
    const next = mergeSettings(current, { quickCommands: [current.quickCommands[0]!] });
    expect(next.composerLayouts.single.rows[0]!.centre).toEqual([
      { id: 'quick:kept', display: 'label' },
    ]);
  });

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

  test('a connections patch is ignored — the list mutates only per-connection', () => {
    // The wholesale array was how a stale tab (or a body like `{"connections": null}`)
    // could delete every connection, and the key pruning that follows a deletion made
    // that irreversible. Pinning the list is what the per-connection endpoints rely on.
    const current = base();
    for (const patch of [
      { connections: [] },
      { connections: null },
      { connections: [{ id: 'intruder', name: 'X' }] },
    ]) {
      const next = mergeSettings(current, patch as never);
      expect(next.connections).toEqual(current.connections);
    }
  });

  test('an unknown connectionId falls back to the first connection', () => {
    const next = mergeSettings(base(), { connectionId: 'missing' });
    expect(next.connectionId).toBe(DEFAULT_CONNECTION_ID);
  });

  test('a known connectionId is kept and revalidated against the pinned list', () => {
    const next = mergeSettings(base(), { connectionId: DEFAULT_CONNECTION_ID });
    expect(next.connectionId).toBe(DEFAULT_CONNECTION_ID);
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

  test('summary preferences merge field-wise and normalize their constrained values', () => {
    const withConnection = {
      ...base(),
      connections: [connection('a', 'A'), connection('b', 'B')],
    };
    const selected = mergeSettings(withConnection, {
      summary: { connectionId: 'b', targetWords: 438, depth: -4, role: 'narrator' } as never,
    });

    expect(selected.summary.connectionId).toBe('b');
    expect(selected.summary.targetWords).toBe(450);
    expect(selected.summary.depth).toBe(0);
    expect(selected.summary.role).toBe(DEFAULT_SUMMARY.role);
    expect(selected.summary.prompt).toBe(DEFAULT_SUMMARY.prompt);
  });

  test('a missing summary connection falls back to following the active chat connection', () => {
    const current = {
      ...base(),
      connections: [connection('a', 'A')],
      summary: { ...DEFAULT_SUMMARY, connectionId: 'deleted' },
    };
    expect(mergeSettings(current, { streamingFps: 60 }).summary.connectionId).toBeNull();
  });

  test('the memory mode defaults to the summary, so an upgrade changes nothing', () => {
    expect(base().memoryMode).toBe('classic');
    expect(mergeSettings(base(), { memoryMode: 'nonsense' as never }).memoryMode).toBe('classic');
    expect(mergeSettings(base(), { memoryMode: 'memories' }).memoryMode).toBe('nexus');
  });

  test('omitting the memory mode leaves it untouched', () => {
    const current = mergeSettings(base(), { memoryMode: 'memories' });
    expect(mergeSettings(current, { streamingFps: 15 }).memoryMode).toBe('nexus');
  });

  test('memory preferences merge field-wise and clamp every numeric field', () => {
    // Each of these costs money or context when wrong: a 5000-message window sends the
    // whole chat in one request, and a budget larger than the context starves the
    // transcript to make room for memories about it.
    const selected = mergeSettings(base(), {
      memory: {
        windowSize: 5000,
        maxMemoryTokens: 1,
        verbatimTail: -10,
        budgetTokens: 999_999,
        depth: -4,
        role: 'narrator',
      } as never,
    });

    expect(selected.memory.windowSize).toBe(200);
    expect(selected.memory.maxMemoryTokens).toBe(100);
    expect(selected.memory.verbatimTail).toBe(0);
    expect(selected.memory.budgetTokens).toBe(32000);
    expect(selected.memory.depth).toBe(0);
    expect(selected.memory.role).toBe(DEFAULT_MEMORY.role);
    expect(selected.memory.extractPrompt).toBe(DEFAULT_MEMORY.extractPrompt);
  });

  test('the auto-extract interval is off by default and only off at exactly zero', () => {
    // A missing or malformed value must never arm a feature that spends money on its own.
    expect(base().memory.autoInterval).toBe(0);
    expect(
      mergeSettings(base(), { memory: { autoInterval: 'often' } as never }).memory.autoInterval,
    ).toBe(0);
    expect(
      mergeSettings(base(), { memory: { autoInterval: 0 } as never }).memory.autoInterval,
    ).toBe(0);
  });

  test('the auto-extract interval clamps to a sane positive range and floors', () => {
    // A typo of 1 would run a paid extraction after every message; nobody wants thousands.
    const selected = mergeSettings(base(), {
      memory: { autoInterval: 75.9 } as never,
    });
    expect(selected.memory.autoInterval).toBe(75);
    expect(
      mergeSettings(selected, { memory: { autoInterval: 5 } as never }).memory.autoInterval,
    ).toBe(10);
    expect(
      mergeSettings(selected, { memory: { autoInterval: 5000 } as never }).memory.autoInterval,
    ).toBe(2000);
  });

  test('auto-hide stays off unless it is explicitly turned on', () => {
    expect(base().memory.autoHide).toBe(false);
    expect(mergeSettings(base(), { memory: { autoHide: 'yes' } as never }).memory.autoHide).toBe(
      false,
    );
    expect(mergeSettings(base(), { memory: { autoHide: true } as never }).memory.autoHide).toBe(
      true,
    );
  });

  test('an emptied extraction prompt falls back rather than shipping a blank system turn', () => {
    expect(
      mergeSettings(base(), { memory: { extractPrompt: '   ' } as never }).memory.extractPrompt,
    ).toBe(DEFAULT_MEMORY.extractPrompt);
  });

  test('a missing memory connection falls back to following the active chat connection', () => {
    const current = {
      ...base(),
      connections: [connection('a', 'A')],
      memory: { ...DEFAULT_MEMORY, connectionId: 'deleted' },
    };
    expect(mergeSettings(current, { streamingFps: 60 }).memory.connectionId).toBeNull();
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

  test('quick commands replace wholesale, an empty list clearing them all', () => {
    const current = mergeSettings(base(), {
      quickCommands: [{ id: 'a', name: 'Ending', text: 'Write an ending.' }],
    });
    expect(current.quickCommands).toEqual([{ id: 'a', name: 'Ending', text: 'Write an ending.' }]);
    expect(mergeSettings(current, { quickCommands: [] }).quickCommands).toEqual([]);
  });

  test('recent personas deduplicate, keep their order, and cap', () => {
    const many = Array.from({ length: MAX_RECENT_PERSONAS + 4 }, (_, i) => `p${i}`);
    const next = mergeSettings(base(), { recentPersonaIds: [...many, 'p0'] });

    expect(next.recentPersonaIds).toEqual(many.slice(0, MAX_RECENT_PERSONAS));
    expect(next.recentPersonaIds).toHaveLength(MAX_RECENT_PERSONAS);
  });

  test('malformed recent-persona entries are dropped rather than reaching the client', () => {
    // The list is mapped over to build the composer's switcher, so a non-string entry is a
    // render crash rather than a bad row.
    const next = mergeSettings(base(), {
      recentPersonaIds: [' a ', '', 42, null, { id: 'b' }, 'c'] as never,
    });
    expect(next.recentPersonaIds).toEqual(['a', 'c']);
  });

  test('a malformed recent-persona patch leaves the list alone', () => {
    const current = mergeSettings(base(), { recentPersonaIds: ['a', 'b'] });
    for (const patch of [{ recentPersonaIds: null }, { recentPersonaIds: 'nope' }, {}]) {
      expect(mergeSettings(current, patch as never).recentPersonaIds).toEqual(['a', 'b']);
    }
    // An explicit empty list is still a legitimate clear.
    expect(mergeSettings(current, { recentPersonaIds: [] }).recentPersonaIds).toEqual([]);
  });

  test('hidden tags trim and deduplicate case-insensitively', () => {
    const next = mergeSettings(base(), {
      hiddenTags: [' OC ', 'oc', 'Fantasy', '', ' fantasy ', 42] as never,
    });

    expect(next.hiddenTags).toEqual(['OC', 'Fantasy']);
    expect(mergeSettings(next, { hiddenTags: [] }).hiddenTags).toEqual([]);
  });

  test('a malformed hidden-tags patch cannot wipe the list', () => {
    const current = mergeSettings(base(), { hiddenTags: ['OC', 'spoiler'] });
    for (const patch of [{ hiddenTags: null }, { hiddenTags: 'nope' }, {}]) {
      expect(mergeSettings(current, patch as never).hiddenTags).toEqual(current.hiddenTags);
    }
  });

  test('character ratings replace wholesale and discard out-of-range values', () => {
    const next = mergeSettings(base(), {
      characterRatings: { 'Alice.png': 5, 'Bob.png': 1, 'Carol.png': 0, 'Dan.png': 6 } as never,
    });
    expect(next.characterRatings).toEqual({ 'Alice.png': 5, 'Bob.png': 1 });
  });

  test('a malformed ratings patch cannot wipe the map', () => {
    // The stale-tab case, same as quick commands: `{"characterRatings": null}` must not
    // erase every rating the user has given.
    const current = mergeSettings(base(), { characterRatings: { 'Alice.png': 4 } });
    for (const patch of [{ characterRatings: null }, { characterRatings: 'nope' }, {}]) {
      expect(mergeSettings(current, patch as never).characterRatings).toEqual({
        'Alice.png': 4,
      });
    }
  });

  test('a fractional or string rating is dropped rather than reaching the UI', () => {
    const next = mergeSettings(base(), {
      characterRatings: { 'Float.png': 2.5, 'String.png': '4', Good: 3 } as never,
    });
    expect(next.characterRatings).toEqual({ Good: 3 });
  });

  test('background effect pairings replace wholesale, but a malformed patch cannot wipe them', () => {
    // The client always sends the whole map (it holds the loaded settings), so a real
    // object replacing is the dialogueColors semantics — the guard exists for the stale
    // tab's `{"backgroundEffects": null}`.
    const current = mergeSettings(base(), {
      backgroundEffects: { 'builtin:stormy-lighthouse': 'rain' },
    });
    const next = mergeSettings(current, { backgroundEffects: { 'user:x.jpg': 'snow' } });
    expect(next.backgroundEffects).toEqual({ 'user:x.jpg': 'snow' });
    for (const patch of [{ backgroundEffects: null }, { backgroundEffects: 'rain' }]) {
      expect(mergeSettings(current, patch as never).backgroundEffects).toEqual({
        'builtin:stormy-lighthouse': 'rain',
      });
    }
  });

  test('non-string pairing entries are dropped on the way in', () => {
    const next = mergeSettings(base(), {
      backgroundEffects: {
        Good: 'rain',
        'No-effect': 42,
        '': 'snow',
        Nested: { id: 'x' },
      } as never,
    });
    expect(next.backgroundEffects).toEqual({ Good: 'rain' });
  });

  test('backgroundEffectLayer accepts only behind and front', () => {
    const next = mergeSettings(base(), { backgroundEffectLayer: 'front' });
    expect(next.backgroundEffectLayer).toBe('front');
    expect(
      mergeSettings(next, { backgroundEffectLayer: 'above' } as never).backgroundEffectLayer,
    ).toBe('front');
  });

  test('characterListSort accepts only the two known values', () => {
    expect(mergeSettings(base(), { characterListSort: 'rating' }).characterListSort).toBe('rating');
    expect(mergeSettings(base(), { characterListSort: 'name' }).characterListSort).toBe('name');
    const current = mergeSettings(base(), { characterListSort: 'rating' });
    for (const patch of [{ characterListSort: 'bogus' }, { characterListSort: null }, {}]) {
      expect(mergeSettings(current, patch as never).characterListSort).toBe('rating');
    }
  });

  test('a malformed quick-commands patch cannot wipe the list', () => {
    // The stale-tab case: a body like `{"quickCommands": null}` rides the plain spread
    // unless pinned, and the user's commands would be gone with no way back.
    const current = mergeSettings(base(), {
      quickCommands: [{ id: 'a', name: 'Ending', text: 'Write an ending.' }],
    });
    for (const patch of [{ quickCommands: null }, { quickCommands: 'nope' }, {}]) {
      expect(mergeSettings(current, patch as never).quickCommands).toEqual(current.quickCommands);
    }
  });

  test('malformed quick-command entries are coerced or dropped, duplicate ids first wins', () => {
    const next = mergeSettings(base(), {
      quickCommands: [
        { id: 'a', name: 'Kept', text: 'first' },
        { id: 'a', name: 'Shadowed', text: 'second' },
        { id: '  ', name: 'No id', text: 'dropped' },
        { name: 'Also no id', text: 'dropped' },
        { id: 'b', name: 42, text: null },
        'junk',
      ] as never,
    });
    expect(next.quickCommands).toEqual([
      { id: 'a', name: 'Kept', text: 'first' },
      { id: 'b', name: '', text: '' },
    ]);
  });

  test('regex scripts replace wholesale, an empty list clearing them all', () => {
    const current = mergeSettings(base(), {
      regexScripts: [{ id: 'a', scriptName: 'hide tag' }] as never,
    });
    expect(current.regexScripts).toHaveLength(1);
    expect(current.regexScripts[0]?.scriptName).toBe('hide tag');
    expect(mergeSettings(current, { regexScripts: [] }).regexScripts).toEqual([]);
  });

  test('a malformed regex-scripts patch cannot wipe the list', () => {
    const current = mergeSettings(base(), {
      regexScripts: [{ id: 'a', scriptName: 'hide tag' }] as never,
    });
    for (const patch of [{ regexScripts: null }, { regexScripts: 'nope' }, {}]) {
      expect(mergeSettings(current, patch as never).regexScripts).toEqual(current.regexScripts);
    }
  });

  test('malformed regex-script entries are coerced or dropped, duplicate ids first wins', () => {
    const next = mergeSettings(base(), {
      regexScripts: [
        { id: 'a', scriptName: 'Kept' },
        { id: 'a', scriptName: 'Shadowed' },
        { id: '  ', scriptName: 'No id' },
        { scriptName: 'Also no id' },
        'junk',
      ] as never,
    });
    expect(next.regexScripts.map((script) => script.scriptName)).toEqual(['Kept']);
  });

  test('an uncompilable find pattern is stored verbatim', () => {
    // The user is mid-typing on every keystroke. A script that vanished as you typed `/[`
    // would be unusable, and ST's contract is that a bad pattern does nothing instead.
    const next = mergeSettings(base(), {
      regexScripts: [{ id: 'a', scriptName: 'wip', findRegex: '/[unclosed/' }] as never,
    });
    expect(next.regexScripts[0]?.findRegex).toBe('/[unclosed/');
  });

  test('a placement value we do not implement survives the round trip', () => {
    const next = mergeSettings(base(), {
      regexScripts: [{ id: 'a', scriptName: 'legacy', placement: [1, 4] }] as never,
    });
    expect(next.regexScripts[0]?.placement).toEqual([1, 4]);
  });
});

describe('arena settings', () => {
  test('a partial arena patch keeps every untouched field', () => {
    const current = mergeSettings(base(), {
      arena: {
        contenders: [{ id: 'k', name: 'Sonnet', connectionId: 'or', model: 'a/b', enabled: true }],
        probes: [{ id: 'p', text: 'Say something.' }],
      } as never,
    });

    const next = mergeSettings(current, { arena: { columns: 3 } as never });

    expect(next.arena.columns).toBe(3);
    expect(next.arena.contenders).toHaveLength(1);
    expect(next.arena.probes).toEqual([{ id: 'p', text: 'Say something.' }]);
  });

  test('a stale tab cannot wipe the pool with a null array', () => {
    // The whole reason the three arrays are guarded on Array.isArray inside the branch:
    // normalizeArena turns a non-array into an empty one, and a wiped contender pool takes
    // the leaderboard's labels with it.
    const current = mergeSettings(base(), {
      arena: {
        contenders: [{ id: 'k', name: 'Sonnet', connectionId: 'or', model: 'a/b', enabled: true }],
        cardPool: ['Seraphina.png'],
        probes: [{ id: 'p', text: 'Say something.' }],
      } as never,
    });

    for (const patch of [
      { arena: { contenders: null, cardPool: null, probes: null } },
      { arena: { contenders: 'nope', cardPool: 'nope', probes: 'nope' } },
      { arena: {} },
    ]) {
      const next = mergeSettings(current, patch as never);
      expect(next.arena.contenders).toEqual(current.arena.contenders);
      expect(next.arena.cardPool).toEqual(current.arena.cardPool);
      expect(next.arena.probes).toEqual(current.arena.probes);
    }
  });

  test('an explicitly empty pool is emptying it on purpose, and stays empty', () => {
    const current = mergeSettings(base(), {
      arena: { contenders: [{ id: 'k', name: '', connectionId: 'or', model: '', enabled: true }] },
    } as never);

    expect(mergeSettings(current, { arena: { contenders: [] } } as never).arena.contenders).toEqual(
      [],
    );
  });

  test('contenders without a usable id are dropped, duplicates keep the first', () => {
    const next = mergeSettings(base(), {
      arena: {
        contenders: [
          { name: 'no id' },
          { id: '  ', name: 'blank id' },
          { id: 'k', name: 'first' },
          { id: 'k', name: 'second' },
        ],
      },
    } as never);

    expect(next.arena.contenders).toEqual([
      { id: 'k', name: 'first', connectionId: '', model: '', enabled: true },
    ]);
  });

  test('a contender pointing at a deleted connection is kept, not dropped', () => {
    // It is unusable, not invalid — and recorded rounds still name it. Dropping it here
    // would rewrite the leaderboard's labels the moment someone tidied their connections.
    const next = mergeSettings(base(), {
      arena: {
        contenders: [{ id: 'k', name: 'Sonnet', connectionId: 'deleted-long-ago', model: 'a/b' }],
      },
    } as never);

    expect(next.arena.contenders[0]?.connectionId).toBe('deleted-long-ago');
  });

  test('columns are clamped rather than rejected', () => {
    expect(mergeSettings(base(), { arena: { columns: 9 } } as never).arena.columns).toBe(4);
    expect(mergeSettings(base(), { arena: { columns: 1 } } as never).arena.columns).toBe(2);
    expect(mergeSettings(base(), { arena: { columns: 'x' } } as never).arena.columns).toBe(2);
  });

  test('the card pool deduplicates and drops blanks', () => {
    const next = mergeSettings(base(), {
      arena: { cardPool: ['a.png', 'a.png', '  ', 'b.png'] },
    } as never);

    expect(next.arena.cardPool).toEqual(['a.png', 'b.png']);
  });

  test('holdBlindUntilComplete is on unless explicitly turned off', () => {
    expect(mergeSettings(base(), { arena: {} } as never).arena.holdBlindUntilComplete).toBe(true);
    expect(
      mergeSettings(base(), { arena: { holdBlindUntilComplete: false } } as never).arena
        .holdBlindUntilComplete,
    ).toBe(false);
  });
});

describe('co-creator settings', () => {
  test('a partial coCreator patch keeps every untouched field', () => {
    // The bug a shallow spread would cause: picking a model in the Co-Creator silently
    // resets the system prompt someone spent an afternoon tuning.
    const next = mergeSettings(base(), { coCreator: { presetId: 'design' } as never });

    expect(next.coCreator.presetId).toBe('design');
    expect(next.coCreator.systemPrompt).toBe(DEFAULT_COCREATOR.systemPrompt);
    expect(next.coCreator.analysisPrompt).toBe(DEFAULT_COCREATOR.analysisPrompt);
    expect(next.coCreator.connectionId).toBeNull();
  });

  test('toggling one example field does not reset the other seven', () => {
    // exampleFields is nested one level deeper than the rest of the block, so it needs its
    // own spread — without it, checking "example dialogue" would uncheck everything else.
    const next = mergeSettings(base(), {
      coCreator: { exampleFields: { mes_example: true } } as never,
    });

    expect(next.coCreator.exampleFields.mes_example).toBe(true);
    expect(next.coCreator.exampleFields.description).toBe(true);
    expect(next.coCreator.exampleFields.personality).toBe(true);
    expect(next.coCreator.exampleFields.character_book).toBe(false);
  });

  test('an example field set to false stays false — it is a value, not an absence', () => {
    const off = mergeSettings(base(), {
      coCreator: { exampleFields: { description: false } } as never,
    });

    expect(off.coCreator.exampleFields.description).toBe(false);
    expect(mergeSettings(off, { streamingFps: 15 }).coCreator.exampleFields.description).toBe(
      false,
    );
  });

  test('omitting coCreator leaves it untouched', () => {
    const current = mergeSettings(base(), { coCreator: { systemPrompt: 'Mine.' } as never });

    expect(mergeSettings(current, { streamingFps: 15 }).coCreator.systemPrompt).toBe('Mine.');
  });

  test('blank Co-Creator prompts restore the built-ins', () => {
    const next = mergeSettings(base(), {
      coCreator: { systemPrompt: ' ', analysisPrompt: '' } as never,
    });
    expect(next.coCreator.systemPrompt).toBe(DEFAULT_COCREATOR.systemPrompt);
    expect(next.coCreator.analysisPrompt).toBe(DEFAULT_COCREATOR.analysisPrompt);
  });

  test('a connectionId naming no saved connection falls back to following the chat', () => {
    const next = mergeSettings(base(), { coCreator: { connectionId: 'ghost' } as never });

    expect(next.coCreator.connectionId).toBeNull();
  });

  test('a wrong-typed field falls back to its default rather than poisoning the file', () => {
    const next = mergeSettings(base(), { coCreator: { systemPrompt: 42 } as never });

    expect(next.coCreator.systemPrompt).toBe(DEFAULT_COCREATOR.systemPrompt);
  });

  test('exampleSets normalizes valid sets and drops malformed entries', () => {
    const next = mergeSettings(base(), {
      coCreator: {
        exampleSets: [
          {
            id: 'set-1',
            name: 'Fantasy Benchmarks',
            cards: ['elf.png', 'knight.png'],
            fields: { description: true, scenario: false },
          },
          { id: '', name: 'Empty ID' }, // dropped
          { id: 'set-1', name: 'Duplicate ID' }, // dropped
          'invalid' as never, // dropped
        ],
      } as never,
    });

    expect(next.coCreator.exampleSets).toEqual([
      {
        id: 'set-1',
        name: 'Fantasy Benchmarks',
        cards: ['elf.png', 'knight.png'],
        fields: {
          ...DEFAULT_COCREATOR.exampleFields,
          description: true,
          scenario: false,
        },
      },
    ]);
  });

  test('streaming defaults to true when absent from stored settings', () => {
    const next = mergeSettings(base(), {});
    expect(next.coCreator.streaming).toBe(true);
  });

  test('streaming can be toggled off without losing other fields', () => {
    const next = mergeSettings(base(), { coCreator: { streaming: false } as never });

    expect(next.coCreator.streaming).toBe(false);
    expect(next.coCreator.systemPrompt).toBe(DEFAULT_COCREATOR.systemPrompt);
    expect(next.coCreator.presetId).toBeNull();
  });

  test('streaming reverts to the default when set to a non-boolean', () => {
    const next = mergeSettings(base(), { coCreator: { streaming: 'yes' } as never });

    expect(next.coCreator.streaming).toBe(true);
  });

  test('explicit streaming true survives a round-trip', () => {
    const first = mergeSettings(base(), { coCreator: { streaming: true } as never });
    const second = mergeSettings(first, { streamingFps: 15 });

    expect(second.coCreator.streaming).toBe(true);
  });
});

describe('example set character identity changes', () => {
  test('a character rename updates references across saved example sets', () => {
    const current = mergeSettings(base(), {
      coCreator: {
        exampleSets: [
          {
            id: 's1',
            name: 'Set 1',
            cards: ['Old.png', 'Other.png'],
            fields: { ...DEFAULT_COCREATOR.exampleFields },
          },
          {
            id: 's2',
            name: 'Set 2',
            cards: ['Unrelated.png'],
            fields: { ...DEFAULT_COCREATOR.exampleFields },
          },
        ],
      } as never,
    });

    const next = reassignCharacterExampleSets(current, 'Old.png', 'New.png');
    expect(next?.coCreator.exampleSets[0]?.cards).toEqual(['New.png', 'Other.png']);
    expect(next?.coCreator.exampleSets[1]?.cards).toEqual(['Unrelated.png']);

    expect(reassignCharacterExampleSets(current, 'Missing.png', 'New.png')).toBeNull();
  });

  test('deleting a character removes it from saved example sets', () => {
    const current = mergeSettings(base(), {
      coCreator: {
        exampleSets: [
          {
            id: 's1',
            name: 'Set 1',
            cards: ['Doomed.png', 'Kept.png'],
            fields: { ...DEFAULT_COCREATOR.exampleFields },
          },
        ],
      } as never,
    });

    const next = reassignCharacterExampleSets(current, 'Doomed.png', null);
    expect(next?.coCreator.exampleSets[0]?.cards).toEqual(['Kept.png']);
  });

  test('coCreator quick commands replace wholesale, an empty list clearing them all', () => {
    const current = mergeSettings(base(), {
      coCreator: {
        quickCommands: [{ id: 'c1', name: 'Openings', text: 'Give me 3 alternate openings.' }],
      } as never,
    });
    expect(current.coCreator.quickCommands).toEqual([
      { id: 'c1', name: 'Openings', text: 'Give me 3 alternate openings.' },
    ]);
    expect(
      mergeSettings(current, { coCreator: { quickCommands: [] } as never }).coCreator.quickCommands,
    ).toEqual([]);
  });

  test('a malformed coCreator quick-commands patch cannot wipe the list', () => {
    const current = mergeSettings(base(), {
      coCreator: {
        quickCommands: [{ id: 'c1', name: 'Openings', text: 'Give me 3 alternate openings.' }],
      } as never,
    });
    for (const patch of [
      { coCreator: { quickCommands: null } },
      { coCreator: { quickCommands: 'bad' } },
      { coCreator: {} },
    ]) {
      expect(mergeSettings(current, patch as never).coCreator.quickCommands).toEqual(
        current.coCreator.quickCommands,
      );
    }
  });

  test('coCreator quick commands remain separate from chat quick commands', () => {
    const next = mergeSettings(base(), {
      quickCommands: [{ id: 'chat-cmd', name: 'Chat Cmd', text: 'Chat text' }],
      coCreator: {
        quickCommands: [{ id: 'cc-cmd', name: 'CoCreator Cmd', text: 'CoCreator text' }],
      } as never,
    });
    expect(next.quickCommands).toEqual([{ id: 'chat-cmd', name: 'Chat Cmd', text: 'Chat text' }]);
    expect(next.coCreator.quickCommands).toEqual([
      { id: 'cc-cmd', name: 'CoCreator Cmd', text: 'CoCreator text' },
    ]);
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

describe('character rating identity changes', () => {
  test('a character rename carries its rating to the new identity', () => {
    const current = mergeSettings(base(), {
      characterRatings: { 'Old.png': 4, 'Other.png': 2 },
    });
    const next = reassignCharacterRating(current, 'Old.png', 'New.png');

    expect(next?.characterRatings).toEqual({ 'New.png': 4, 'Other.png': 2 });
    // A rating for a filename nobody had is nothing to persist.
    expect(reassignCharacterRating(current, 'Missing.png', 'New.png')).toBeNull();
  });

  test('deleting a character removes only its rating', () => {
    const current = mergeSettings(base(), {
      characterRatings: { doomed: 5, kept: 1 },
    });
    expect(reassignCharacterRating(current, 'doomed', null)?.characterRatings).toEqual({
      kept: 1,
    });
  });

  test('an unrated character is indistinguishable from no entry', () => {
    const current = mergeSettings(base(), { characterRatings: { rated: 3 } });
    expect(reassignCharacterRating(current, 'rated', null)).not.toBeNull();
    expect(reassignCharacterRating(current, 'absent', null)).toBeNull();
  });
});

describe('arena card pool identity changes', () => {
  test('a character rename carries its pool slot to the new identity, in place', () => {
    const current = mergeSettings(base(), {
      arena: { ...base().arena, cardPool: ['Old.png', 'Middle.png', 'Other.png'] },
    });
    const next = reassignArenaCardPool(current, 'Old.png', 'New.png');

    expect(next?.arena.cardPool).toEqual(['New.png', 'Middle.png', 'Other.png']);
    // A pool that never named the card is nothing to persist.
    expect(reassignArenaCardPool(current, 'Missing.png', 'New.png')).toBeNull();
  });

  test('deleting a character removes only its pool slot', () => {
    const current = mergeSettings(base(), {
      arena: { ...base().arena, cardPool: ['Doomed.png', 'Kept.png'] },
    });
    expect(reassignArenaCardPool(current, 'Doomed.png', null)?.arena.cardPool).toEqual([
      'Kept.png',
    ]);
  });

  test('an unlisted card is indistinguishable from an empty pool', () => {
    const current = mergeSettings(base(), {
      arena: { ...base().arena, cardPool: ['Other.png'] },
    });
    expect(reassignArenaCardPool(current, 'absent', null)).toBeNull();
    expect(reassignArenaCardPool(current, 'absent', 'Renamed.png')).toBeNull();
  });
});

describe('applyConnectionPatch', () => {
  function list(): Connection[] {
    return [connection('a', 'Local'), connection('b', 'OpenRouter')];
  }

  test('merges into one entry, normalising per field', () => {
    const next = applyConnectionPatch(list(), 'b', { model: 'x/y', showReasoning: false });
    expect(next?.[1]).toMatchObject({ id: 'b', model: 'x/y', showReasoning: false });
    expect(next?.[0]).toEqual(list()[0]);
  });

  test('a bad provider falls back rather than reaching the wire', () => {
    const next = applyConnectionPatch(list(), 'a', { provider: 'nope' });
    expect(next?.[0]?.provider).toBe('custom');
  });

  test('clearing the baseUrl falls back to the provider default', () => {
    const next = applyConnectionPatch(list(), 'a', { baseUrl: '   ' });
    expect(next?.[0]?.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('reportUsage can be switched off', () => {
    const on = applyConnectionPatch(list(), 'a', { reportUsage: true });
    expect(on?.[0]?.reportUsage).toBe(true);
    const off = applyConnectionPatch(on!, 'a', { reportUsage: false });
    expect(off?.[0]?.reportUsage).toBeUndefined();
  });

  test('the id cannot be patched away — it keys the secret store', () => {
    const next = applyConnectionPatch(list(), 'a', { id: 'evil' });
    expect(next?.[0]?.id).toBe('a');
  });

  test('an unknown id changes nothing', () => {
    expect(applyConnectionPatch(list(), 'zzz', { model: 'x' })).toBeNull();
  });

  test('edits do not mutate the input', () => {
    const original = list();
    const snapshot = structuredClone(original);
    applyConnectionPatch(original, 'a', { name: 'changed' });
    expect(original).toEqual(snapshot);
  });
});

describe('dropConnection', () => {
  function list(): Connection[] {
    return [connection('a', 'A'), connection('b', 'B'), connection('c', 'C')];
  }

  test('dropping the selected entry falls back to the first remaining', () => {
    const next = dropConnection(list(), 'b', 'b');
    expect(next?.connections.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(next?.connectionId).toBe('a');
  });

  test('a selection pointing elsewhere survives the deletion', () => {
    expect(dropConnection(list(), 'c', 'a')?.connectionId).toBe('c');
  });

  test('dropping the only connection clears the selection', () => {
    const next = dropConnection([connection('a', 'Solo')], 'a', 'a');
    expect(next?.connections).toEqual([]);
    expect(next?.connectionId).toBeNull();
  });

  test('an unknown id changes nothing', () => {
    expect(dropConnection(list(), 'a', 'zzz')).toBeNull();
  });
});

describe('nextConnectionName', () => {
  test('the first connection takes the bare provider label', () => {
    expect(nextConnectionName([], 'custom')).toBe('OpenAI-compatible');
  });

  test('fills the lowest free slot rather than counting entries', () => {
    const connections = [
      connection('a', 'OpenAI-compatible'),
      connection('c', 'OpenAI-compatible 3'),
    ];
    expect(nextConnectionName(connections, 'custom')).toBe('OpenAI-compatible 2');
  });

  test('a user-chosen name never blocks a slot', () => {
    expect(nextConnectionName([connection('a', 'Groq')], 'custom')).toBe('OpenAI-compatible');
  });
});

describe('sameEndpoint', () => {
  test('same provider and base URL is the same endpoint', () => {
    expect(sameEndpoint(connection('a', 'A'), connection('b', 'B', { baseUrl: 'http://a' }))).toBe(
      true,
    );
  });

  test('trailing slashes and surrounding whitespace are not a move', () => {
    expect(
      sameEndpoint(connection('a', 'A', { baseUrl: 'http://a' }), {
        provider: 'custom',
        baseUrl: '  http://a/  ',
      }),
    ).toBe(true);
  });

  test('a different URL or provider is a different endpoint', () => {
    expect(
      sameEndpoint(connection('a', 'A'), connection('a', 'A', { baseUrl: 'http://elsewhere' })),
    ).toBe(false);
    expect(
      sameEndpoint(connection('a', 'A'), connection('a', 'A', { provider: 'openrouter' })),
    ).toBe(false);
  });
});

describe('migrateLegacyConnection', () => {
  function legacy() {
    return {
      connection: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude',
        showReasoning: false,
        reportUsage: true,
      },
      streamingFps: 30,
    };
  }

  test('wraps the legacy connection in a one-entry list and reports the key move', () => {
    const migration = migrateLegacyConnection(legacy(), 'new-id');
    expect(migration).not.toBeNull();
    if (!migration) return;

    const connections = migration.settings.connections as Connection[];
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: 'new-id',
      // No name existed in the old format; the provider label is the fallback.
      name: 'OpenRouter',
      provider: 'openrouter',
      model: 'anthropic/claude',
      showReasoning: false,
      reportUsage: true,
    });
    expect(migration.settings.connectionId).toBe('new-id');
    expect(migration.settings.connection).toBeUndefined();
    // Unrelated keys ride along untouched.
    expect(migration.settings.streamingFps).toBe(30);
    expect(migration.keyMove).toEqual({ from: 'openrouter', to: 'new-id' });
  });

  test('a file that already has connections is left alone', () => {
    expect(migrateLegacyConnection({ connections: [] }, 'new-id')).toBeNull();
  });

  test('a file without a legacy connection is left alone', () => {
    expect(migrateLegacyConnection({ streamingFps: 30 }, 'new-id')).toBeNull();
  });
});

/*
 * !! paths.ts and the settings cache are module state shared by every test file in the
 * process. !! These tests repoint both at a temp directory; the afterEach puts them
 * back, same rule as paths.test.ts.
 */
describe('legacy migration on disk', () => {
  afterEach(() => {
    setDataDir(DEFAULT_DATA_DIR);
    resetSettingsCache();
  });

  function seedLegacy(dir: string, secrets: Record<string, string>) {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        connection: {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'anthropic/claude',
        },
        streamingFps: 30,
      }),
    );
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets), { mode: 0o600 });
  }

  test('migrates on first read, and the key moves with the connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-migrate-'));
    try {
      setDataDir(dir);
      resetSettingsCache();
      seedLegacy(dir, { openrouter: 'sk-or-1234', custom: 'sk-leftover' });

      const settings = getSettings();
      expect(settings.connections.map((connection) => connection.id)).toEqual([
        MIGRATION_CONNECTION_ID,
      ]);
      expect(settings.connectionId).toBe(MIGRATION_CONNECTION_ID);
      expect(settings.streamingFps).toBe(30);

      expect(getApiKey(MIGRATION_CONNECTION_ID)).toBe('sk-or-1234');
      expect(getApiKey('openrouter')).toBeNull();
      // A key for a provider with no connection has nowhere to move and is left alone.
      expect(getApiKey('custom')).toBe('sk-leftover');

      // The file on disk caught up, so the migration never runs again.
      const stored = JSON.parse(readFileSync(PATHS.settings, 'utf8'));
      expect(stored.connectionId).toBe(MIGRATION_CONNECTION_ID);
      expect(stored.connection).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a crash between the re-key and the settings write converges on retry', () => {
    // The deterministic id is what makes this safe: the retry computes the same id, so
    // the key the first attempt already moved is exactly where the second looks. With a
    // fresh uuid per attempt, the key would sit under the first attempt's id while
    // settings pointed at the second's, and the next prune would delete it.
    const dir = mkdtempSync(join(tmpdir(), 'wc-migrate-'));
    try {
      setDataDir(dir);
      resetSettingsCache();
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          connection: {
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'x',
          },
        }),
      );
      // Secrets already re-keyed by the interrupted first attempt.
      writeFileSync(
        join(dir, 'secrets.json'),
        JSON.stringify({ [MIGRATION_CONNECTION_ID]: 'sk-or-1234' }),
        { mode: 0o600 },
      );

      const settings = getSettings();
      expect(settings.connections[0]?.id).toBe(MIGRATION_CONNECTION_ID);
      expect(getApiKey(MIGRATION_CONNECTION_ID)).toBe('sk-or-1234');

      const stored = JSON.parse(readFileSync(PATHS.settings, 'utf8'));
      expect(stored.connectionId).toBe(MIGRATION_CONNECTION_ID);
      expect(stored.connection).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('getSettings on disk', () => {
  afterEach(() => {
    setDataDir(DEFAULT_DATA_DIR);
    resetSettingsCache();
  });

  test('recentPersonaIds is deduplicated, trimmed, and capped at MAX_RECENT_PERSONAS on read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-settings-read-'));
    try {
      setDataDir(dir);
      resetSettingsCache();
      const many = Array.from({ length: MAX_RECENT_PERSONAS + 4 }, (_, i) => `p${i}`);
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          recentPersonaIds: ['  p0  ', ...many, 'p0', '', 42, null, { id: 'bad' }],
        }),
      );

      const settings = getSettings();
      expect(settings.recentPersonaIds).toEqual(many.slice(0, MAX_RECENT_PERSONAS));
      expect(settings.recentPersonaIds).toHaveLength(MAX_RECENT_PERSONAS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing or non-array recentPersonaIds on disk defaults to an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-settings-read-'));
    try {
      setDataDir(dir);
      resetSettingsCache();
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ recentPersonaIds: 'not-an-array' }),
      );

      expect(getSettings().recentPersonaIds).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('background effect settings default when absent and normalise when malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-settings-read-'));
    try {
      setDataDir(dir);
      resetSettingsCache();
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({}));

      const fresh = getSettings();
      expect(fresh.backgroundEffectEnabled).toBe(true);
      expect(fresh.backgroundEffects).toEqual({});
      expect(fresh.backgroundEffectLayer).toBe('behind');

      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          backgroundEffectEnabled: 'yes',
          backgroundEffects: 'not-a-map',
          backgroundEffectLayer: 'above',
        }),
      );
      resetSettingsCache();
      expect(getSettings().backgroundEffectEnabled).toBe(true);
      expect(getSettings().backgroundEffects).toEqual({});
      expect(getSettings().backgroundEffectLayer).toBe('behind');

      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          backgroundEffectEnabled: false,
          backgroundEffects: { 'builtin:x': 'rain', Bad: 7, '': 'snow' },
          backgroundEffectLayer: 'front',
        }),
      );
      resetSettingsCache();
      const settings = getSettings();
      expect(settings.backgroundEffectEnabled).toBe(false);
      expect(settings.backgroundEffects).toEqual({ 'builtin:x': 'rain' });
      expect(settings.backgroundEffectLayer).toBe('front');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
