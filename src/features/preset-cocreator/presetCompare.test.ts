import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { getPromptOrder, setPromptOrder } from '@shared/prompt/preset-io.ts';
import type { Preset } from '@shared/types/preset.ts';
import {
  buildSideBySide,
  type CompareSource,
  decodeSource,
  defaultCompareSources,
  encodeSource,
  splitSides,
} from './presetCompare.ts';
import { diffText } from './textDiff.ts';

function withPrompt(preset: Preset, identifier: string, content: string): Preset {
  return {
    ...preset,
    prompts: preset.prompts!.map((prompt) =>
      prompt.identifier === identifier ? { ...prompt, content } : prompt,
    ),
  };
}

function addPrompt(preset: Preset, identifier: string, content: string): Preset {
  const next: Preset = {
    ...preset,
    prompts: [...preset.prompts!, { identifier, name: `Custom ${identifier}`, content }],
  };
  return setPromptOrder(next, [...getPromptOrder(next), { identifier, enabled: true }]);
}

describe('compare sources', () => {
  test('every source round-trips through its Select value', () => {
    const sources: CompareSource[] = [
      { kind: 'draft' },
      { kind: 'revision', revision: 0 },
      { kind: 'revision', revision: 12 },
      { kind: 'library', id: 'My: preset' },
      { kind: 'reference', id: 'Found online' },
    ];
    for (const source of sources) expect(decodeSource(encodeSource(source))).toEqual(source);
  });

  test('a value that names no source decodes to null', () => {
    expect(decodeSource('')).toBeNull();
    expect(decodeSource('revision:abc')).toBeNull();
    expect(decodeSource('elsewhere:x')).toBeNull();
    expect(decodeSource('library:')).toBeNull();
  });

  test('a linked session starts as the library preset against the draft', () => {
    expect(defaultCompareSources({ targetPresetId: 'Mine', history: [{ revision: 0 }] })).toEqual({
      left: { kind: 'library', id: 'Mine' },
      right: { kind: 'draft' },
    });
  });

  test('an unlinked session starts as its first revision against the draft', () => {
    expect(
      defaultCompareSources({ targetPresetId: null, history: [{ revision: 0 }, { revision: 1 }] }),
    ).toEqual({ left: { kind: 'revision', revision: 0 }, right: { kind: 'draft' } });
  });
});

describe('side by side', () => {
  test('identical presets have no differences and every row is the same', () => {
    const preset = createDefaultPreset();
    const view = buildSideBySide(preset, structuredClone(preset));
    expect(view.differences).toBe(0);
    expect(view.order).toEqual([]);
    expect(view.prompts.every((row) => row.status === 'same')).toBe(true);
    expect(view.settings.every((row) => row.status === 'same')).toBe(true);
  });

  test('prompts follow the new side’s live order and match by identifier', () => {
    const left = createDefaultPreset();
    const right = withPrompt(left, 'main', 'A rewritten main prompt.');
    const view = buildSideBySide(left, right);
    expect(view.prompts.map((row) => row.key)).toEqual(
      getPromptOrder(right).map((entry) => `prompt:${entry.identifier}`),
    );
    const main = view.prompts.find((row) => row.key === 'prompt:main')!;
    expect(main.status).toBe('changed');
    expect(main.right?.content).toBe('A rewritten main prompt.');
    expect(view.differences).toBe(1);
  });

  test('a prompt only on one side is added or removed, with an empty other side', () => {
    const base = createDefaultPreset();
    const withExtra = addPrompt(base, 'extra', 'Stay in second person.');

    const added = buildSideBySide(base, withExtra).prompts.find(
      (row) => row.key === 'prompt:extra',
    )!;
    expect(added).toMatchObject({ status: 'added', left: null });
    expect(added.right?.content).toBe('Stay in second person.');

    // A prompt only the old side has still gets a row, after the new side's prompts.
    const removedView = buildSideBySide(withExtra, base);
    const removed = removedView.prompts.at(-1)!;
    expect(removed).toMatchObject({ key: 'prompt:extra', status: 'removed', right: null });
  });

  test('toggling a prompt changes its row even when the text is identical', () => {
    const left = createDefaultPreset();
    const right = setPromptOrder(
      left,
      getPromptOrder(left).map((entry) =>
        entry.identifier === 'main' ? { ...entry, enabled: false } : entry,
      ),
    );
    const view = buildSideBySide(left, right);
    const main = view.prompts.find((row) => row.key === 'prompt:main')!;
    expect(main.status).toBe('changed');
    expect(main.left?.enabled).toBe(true);
    expect(main.right?.enabled).toBe(false);
    expect(view.order).toContain('Disabled Main Prompt');
  });

  test('settings are labelled, and only differing ones count', () => {
    const left = createDefaultPreset();
    const right = { ...left, temperature: 1.25 };
    const view = buildSideBySide(left, right);
    const temperature = view.settings.find((row) => row.key === 'setting:temperature')!;
    expect(temperature).toMatchObject({ label: 'Temperature', status: 'changed', kind: 'value' });
    expect(view.differences).toBe(1);
  });

  test('a setting present on one side only is added or removed', () => {
    const left = createDefaultPreset();
    const right: Preset = { ...left, some_new_key: 'hello' };
    const view = buildSideBySide(left, right);
    expect(view.settings.find((row) => row.key === 'setting:some_new_key')?.status).toBe('added');
    expect(
      buildSideBySide(right, left).settings.find((row) => row.key === 'setting:some_new_key')
        ?.status,
    ).toBe('removed');
  });

  test('long text settings are compared as text', () => {
    const left = createDefaultPreset();
    const right = { ...left, impersonation_prompt: `${left.impersonation_prompt ?? ''}\nMore.` };
    const row = buildSideBySide(left, right).settings.find(
      (entry) => entry.key === 'setting:impersonation_prompt',
    )!;
    expect(row.kind).toBe('text');
  });
});

describe('splitting a diff into two sides', () => {
  test('the old side keeps removals, the new side keeps additions, both keep the rest', () => {
    const sides = splitSides(diffText('The quick brown fox jumps.', 'The slow brown fox jumps.'));
    const text = (parts: typeof sides.left) => parts.map((part) => part.text).join('');
    expect(text(sides.left)).toBe('The quick brown fox jumps.');
    expect(text(sides.right)).toBe('The slow brown fox jumps.');
    expect(sides.left.some((part) => part.kind === 'added')).toBe(false);
    expect(sides.right.some((part) => part.kind === 'removed')).toBe(false);
  });

  test('a rewrite shows each whole text as the change on its side', () => {
    const before = 'one two three four five six seven eight nine ten eleven twelve';
    const after = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
    const sides = splitSides(diffText(before, after));
    expect(sides.left).toEqual([{ kind: 'removed', text: before }]);
    expect(sides.right).toEqual([{ kind: 'added', text: after }]);
  });
});
