import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { Preset, Prompt, PromptOrderList } from '@shared/types/preset.ts';
import { PROMPT_ORDER_LIVE_ID } from '@shared/types/preset.ts';
import {
  describeDiffEntries,
  describeOrderChange,
  describePresetChanges,
  formatValue,
} from './presetChanges.ts';

function liveOrder(preset: Preset): PromptOrderList {
  const list = (preset.prompt_order as PromptOrderList[]).find(
    (entry) => entry.character_id === PROMPT_ORDER_LIVE_ID,
  );
  if (!list) throw new Error('default preset has no live order');
  return list;
}

function prompt(preset: Preset, identifier: string): Prompt {
  const found = (preset.prompts as Prompt[]).find((entry) => entry.identifier === identifier);
  if (!found) throw new Error(`no prompt ${identifier}`);
  return found;
}

describe('describePresetChanges', () => {
  test('identical presets have nothing to say', () => {
    expect(describePresetChanges(createDefaultPreset(), createDefaultPreset())).toEqual([]);
  });

  test('a prompt content edit is one text change labelled by the prompt name', () => {
    const before = createDefaultPreset();
    const after = structuredClone(before);
    const main = prompt(after, 'main');
    main.content = `${main.content ?? ''} Keep replies short.`;

    const changes = describePresetChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'text',
      label: `${prompt(before, 'main').name} › content`,
      before: prompt(before, 'main').content,
      after: main.content,
    });
  });

  test('inserting a prompt mid-list is one addition and one order line, not a cascade', () => {
    const before = createDefaultPreset();
    const after = structuredClone(before);
    const added: Prompt = {
      identifier: 'fate-roll',
      name: 'Fate Roll',
      role: 'system',
      content: 'Roll once per risky action.',
    };
    (after.prompts as Prompt[]).splice(3, 0, added);
    liveOrder(after).order.splice(4, 0, { identifier: 'fate-roll', enabled: true });

    const changes = describePresetChanges(before, after);
    expect(changes).toEqual([
      {
        kind: 'prompt',
        key: 'prompt:fate-roll',
        label: 'Fate Roll',
        change: 'added',
        content: 'Roll once per risky action.',
      },
      {
        kind: 'order',
        key: `order:${PROMPT_ORDER_LIVE_ID}`,
        label: 'Prompt order',
        lines: ['Added Fate Roll at position 5'],
      },
    ]);
  });

  test('a removed prompt names what went, from the old preset', () => {
    const before = createDefaultPreset();
    const after = structuredClone(before);
    after.prompts = (after.prompts as Prompt[]).filter((entry) => entry.identifier !== 'nsfw');
    const changes = describePresetChanges(before, after);
    expect(changes[0]).toMatchObject({
      kind: 'prompt',
      change: 'removed',
      label: prompt(before, 'nsfw').name,
    });
  });

  test('settings read as labelled values after the prompts', () => {
    const before = createDefaultPreset();
    const after: Preset = {
      ...structuredClone(before),
      temperature: 0.85,
      reasoning_effort: 'high',
    };
    const labels = describePresetChanges(before, after).map((change) => change.label);
    expect(labels).toEqual(['Temperature', 'Reasoning effort']);
  });

  test('a nested setting becomes one row per changed leaf', () => {
    const before = { ...createDefaultPreset(), extensions: { regex: { enabled: false } } };
    const after = { ...structuredClone(before), extensions: { regex: { enabled: true } } };
    expect(describePresetChanges(before, after)).toEqual([
      {
        kind: 'value',
        key: 'extensions/regex/enabled',
        label: 'Extensions › regex › enabled',
        before: false,
        after: true,
      },
    ]);
  });
});

describe('describeOrderChange', () => {
  const nameOf = (identifier: string) => identifier.toUpperCase();
  const entries = (...ids: string[]) => ids.map((identifier) => ({ identifier, enabled: true }));

  test('moving one entry names only that entry', () => {
    expect(
      describeOrderChange(entries('a', 'b', 'c', 'd'), entries('a', 'c', 'd', 'b'), nameOf),
    ).toEqual(['Moved B to position 4']);
  });

  test('enabling and disabling are their own lines', () => {
    const after = entries('a', 'b');
    after[1]!.enabled = false;
    expect(describeOrderChange(entries('a', 'b'), after, nameOf)).toEqual(['Disabled B']);
  });

  test('removals and disabled additions say so', () => {
    const after = [...entries('a'), { identifier: 'z', enabled: false }];
    expect(describeOrderChange(entries('a', 'b'), after, nameOf)).toEqual([
      'Added Z at position 2, disabled',
      'Removed B',
    ]);
  });
});

describe('describeDiffEntries', () => {
  test('resolves prompt indices to names and keeps text as text', () => {
    const preset = createDefaultPreset();
    const index = (preset.prompts as Prompt[]).findIndex((entry) => entry.identifier === 'main');
    const changes = describeDiffEntries(
      [
        {
          path: `/prompts/${index}/content`,
          kind: 'replace',
          before: 'Write the next reply.\nStay in character.',
          after: 'Write the next reply.\nStay in character, always.',
        },
        { path: '/temperature', kind: 'replace', before: 1, after: 0.9 },
        { path: '/reasoning_effort', kind: 'replace', before: 'high', after: 'medium' },
      ],
      preset,
    );
    expect(changes.map((change) => [change.kind, change.label])).toEqual([
      ['text', `${prompt(preset, 'main').name} › content`],
      ['value', 'Temperature'],
      // Short one-line text is a value: "high → medium", not a word diff.
      ['value', 'Reasoning effort'],
    ]);
  });
});

test('formatValue reads like the settings panel', () => {
  expect(formatValue(true)).toBe('on');
  expect(formatValue(false)).toBe('off');
  expect(formatValue(undefined)).toBe('—');
  expect(formatValue(0.85)).toBe('0.85');
  expect(formatValue('')).toBe('(empty)');
});
