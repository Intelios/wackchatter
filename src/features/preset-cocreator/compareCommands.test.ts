import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { PresetDraftRevision } from '@shared/types/preset-cocreator.ts';
import { compareCommandDraft, PRESET_SLASH_COMMANDS } from './compareCommands.ts';
import {
  comparisonChoices,
  filterComparisonChoices,
  loadComparisonPreset,
} from './compareSources.ts';

describe('Preset Co-Creator /compare', () => {
  test('recognises partial names, source queries and invalid commands without treating them as prose', () => {
    expect(PRESET_SLASH_COMMANDS.map((command) => command.name)).toEqual(['compare']);
    expect(compareCommandDraft('hello /compare')).toEqual({ kind: 'message' });
    expect(compareCommandDraft('/')).toEqual({ kind: 'command', completing: true });
    expect(compareCommandDraft('/comp')).toEqual({ kind: 'command', completing: true });
    expect(compareCommandDraft('/COMPARE')).toEqual({ kind: 'command', completing: false });
    expect(compareCommandDraft('/compare  voice')).toEqual({ kind: 'source', query: 'voice' });
    expect(compareCommandDraft('/comp voice').kind).toBe('invalid');
    expect(compareCommandDraft('/unknown').kind).toBe('invalid');
  });

  test('choices preserve identity when names coincide and exclude the current revision', async () => {
    const old = createDefaultPreset();
    old.temperature = 0.2;
    const current = createDefaultPreset();
    current.temperature = 0.9;
    const history: PresetDraftRevision[] = [
      {
        revision: 0,
        created: 1,
        source: 'initial',
        summary: 'Original',
        turnId: null,
        operationId: 'a',
        preset: old,
        diff: [],
      },
      {
        revision: 1,
        created: 2,
        source: 'manual',
        summary: 'Warmer',
        turnId: null,
        operationId: 'b',
        preset: current,
        diff: [],
      },
    ];
    const choices = comparisonChoices(
      [{ id: 'ref', name: 'Voice', modified: 1 }],
      [{ id: 'mine', name: 'Voice', modified: 1 }],
      history,
      1,
    );
    expect(choices.map((choice) => choice.key)).toEqual([
      'reference:ref',
      'library:mine',
      'revision:0',
    ]);
    expect(filterComparisonChoices(choices, 'voice').map((choice) => choice.key)).toEqual([
      'reference:ref',
      'library:mine',
    ]);
    const snapshot = await loadComparisonPreset({ kind: 'revision', revision: 0 }, history);
    expect(snapshot.temperature).toBe(0.2);
    old.temperature = 0.5;
    expect(snapshot.temperature).toBe(0.2);
  });
});
