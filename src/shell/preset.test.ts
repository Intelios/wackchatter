import { describe, expect, test } from 'bun:test';
import { getPromptOrder, setPromptOrder, updatePrompt } from '@shared/prompt/preset-io.ts';
import type { Preset } from '@shared/types/preset.ts';
import {
  contextSegments,
  presetChanges,
  revertField,
  revertOrder,
  revertPrompt,
  sameValue,
} from './preset.ts';

function preset(): Preset {
  return {
    temperature: 1,
    top_p: 0.9,
    prompts: [
      { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Write.' },
      { identifier: 'chatHistory', name: 'Chat History', marker: true },
      { identifier: 'custom-a', name: 'Combat', role: 'system', content: 'Fight well.' },
      { identifier: 'custom-doc', name: 'Notes', role: 'documentation', content: 'For you.' },
    ],
    prompt_order: [
      { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
      {
        character_id: 100001,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'custom-a', enabled: false },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'custom-doc', enabled: true },
        ],
      },
    ],
  } as unknown as Preset;
}

const toggle = (p: Preset, id: string) =>
  setPromptOrder(
    p,
    getPromptOrder(p).map((e) => (e.identifier === id ? { ...e, enabled: !e.enabled } : e)),
  );

describe('sameValue', () => {
  test('ignores key order and treats a missing key as undefined', () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe('presetChanges', () => {
  test('nothing changed is zero', () => {
    const saved = preset();
    expect(presetChanges(saved, preset()).count).toBe(0);
    expect(presetChanges(null, saved).count).toBe(0);
  });

  test('counts settings, prompts (text and switch) and a reorder apart', () => {
    const saved = preset();
    let next: Preset = { ...saved, temperature: 1.2 };
    next = updatePrompt(next, 'main', { content: 'Write well.' });
    next = toggle(next, 'custom-a');
    const order = getPromptOrder(next);
    next = setPromptOrder(next, [order[2]!, order[0]!, order[1]!, order[3]!]);
    const changes = presetChanges(saved, next);
    expect(changes.fields).toEqual(['temperature']);
    expect(changes.prompts.sort()).toEqual(['custom-a', 'main']);
    expect(changes.reordered).toBe(true);
    expect(changes.count).toBe(4);
  });

  test('a value put back by hand is no longer a change', () => {
    const saved = preset();
    const next = updatePrompt(updatePrompt(saved, 'main', { content: 'x' }), 'main', {
      content: 'Write.',
    });
    expect(presetChanges(saved, next).count).toBe(0);
  });
});

describe('putting one change back', () => {
  test('a setting returns to its saved value, or leaves if it was not there', () => {
    const saved = preset();
    expect(revertField({ ...saved, temperature: 2 }, saved, 'temperature').temperature).toBe(1);
    expect('seed' in revertField({ ...saved, seed: 4 }, saved, 'seed')).toBe(false);
  });

  test('a prompt gets its text and switch back but keeps its new place', () => {
    const saved = preset();
    let next = toggle(updatePrompt(saved, 'custom-a', { content: 'Changed.' }), 'custom-a');
    const order = getPromptOrder(next);
    next = setPromptOrder(next, [order[1]!, order[0]!, order[2]!, order[3]!]);
    const back = revertPrompt(next, saved, 'custom-a');
    expect(back.prompts?.find((p) => p.identifier === 'custom-a')?.content).toBe('Fight well.');
    expect(getPromptOrder(back).map((e) => [e.identifier, e.enabled])).toEqual([
      ['custom-a', false],
      ['main', true],
      ['chatHistory', true],
      ['custom-doc', true],
    ]);
    // The legacy order is never touched.
    expect(back.prompt_order?.[0]).toEqual(saved.prompt_order?.[0]);
    expect(presetChanges(saved, back).prompts).toEqual([]);
  });

  test('a new prompt is removed; a deleted one comes back at the end', () => {
    const saved = preset();
    const added = setPromptOrder(
      { ...saved, prompts: [...(saved.prompts ?? []), { identifier: 'custom-b', name: 'New' }] },
      [...getPromptOrder(saved), { identifier: 'custom-b', enabled: true }],
    );
    expect(presetChanges(saved, revertPrompt(added, saved, 'custom-b')).count).toBe(0);

    const removed = setPromptOrder(
      { ...saved, prompts: saved.prompts?.filter((p) => p.identifier !== 'custom-a') },
      getPromptOrder(saved).filter((e) => e.identifier !== 'custom-a'),
    );
    const back = revertPrompt(removed, saved, 'custom-a');
    expect(getPromptOrder(back).at(-1)).toEqual({ identifier: 'custom-a', enabled: false });
  });

  test('the order goes back without undoing a prompt edit', () => {
    const saved = preset();
    let next = updatePrompt(saved, 'main', { content: 'Edited.' });
    const order = getPromptOrder(next);
    next = setPromptOrder(next, [order[3]!, order[2]!, order[1]!, order[0]!]);
    const back = revertOrder(next, saved);
    const changes = presetChanges(saved, back);
    expect(changes.reordered).toBe(false);
    expect(changes.prompts).toEqual(['main']);
  });
});

describe('contextSegments', () => {
  test('switched-on prompts that cost something, in order, never documentation', () => {
    const tokens: Record<string, number> = { main: 40, 'custom-a': 30, chatHistory: 900 };
    const segments = contextSegments(preset(), (_p, id) => tokens[id] ?? 0);
    expect(segments.map((s) => [s.identifier, s.kind, s.tokens])).toEqual([
      ['main', 'mine', 40],
      ['chatHistory', 'history', 900],
    ]);
  });
});
