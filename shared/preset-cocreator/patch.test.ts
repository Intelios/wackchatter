import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '../prompt/defaults.ts';
import { PROMPT_ORDER_LEGACY_ID } from '../types/preset.ts';
import { applyPresetPatch, diffPreset, validatePresetDraft } from './patch.ts';

describe('Preset Co-Creator patch boundary', () => {
  test('applies a valid patch without mutating the base preset', () => {
    const base = createDefaultPreset();
    const result = applyPresetPatch(base, [
      { op: 'replace', path: '/prompts/0/content', value: 'Write vivid prose.' },
      { op: 'replace', path: '/temperature', value: 0.8 },
    ]);

    expect(result.preset.prompts?.[0]?.content).toBe('Write vivid prose.');
    expect(result.preset.temperature).toBe(0.8);
    expect(base.prompts?.[0]?.content).not.toBe('Write vivid prose.');
    expect(result.diff.map((entry) => entry.path)).toContain('/prompts/0/content');
  });

  test('a leading /preset/ root — the shape read_preset hands the model — is accepted', () => {
    const base = createDefaultPreset();
    const result = applyPresetPatch(base, [
      { op: 'replace', path: '/preset/temperature', value: 0.6 },
      { op: 'test', path: '/preset/openai_max_tokens', value: base.openai_max_tokens },
    ]);

    expect(result.preset.temperature).toBe(0.6);
    // The reported diff stays canonical, rooted at the document like every other diff.
    expect(result.diff).toEqual([{ path: '/temperature', kind: 'replace', before: 1, after: 0.6 }]);
  });

  test('a real top-level preset key is addressed, not stripped', () => {
    const base = { ...createDefaultPreset(), preset: { nested: 'real data' } } as ReturnType<
      typeof createDefaultPreset
    >;
    const result = applyPresetPatch(base, [
      { op: 'replace', path: '/preset/nested', value: 'edited' },
    ]);

    expect((result.preset as unknown as { preset: { nested: string } }).preset.nested).toBe(
      'edited',
    );
  });

  test('rejects unsafe property traversal atomically', () => {
    const base = createDefaultPreset();
    expect(() =>
      applyPresetPatch(base, [
        { op: 'replace', path: '/temperature', value: 0.7 },
        { op: 'add', path: '/__proto__/polluted', value: true },
      ]),
    ).toThrow('unsafe');
    expect(base.temperature).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('protects connection compatibility fields', () => {
    const base = { ...createDefaultPreset(), custom_url: 'https://example.invalid/v1' };
    expect(() =>
      applyPresetPatch(base, [
        { op: 'replace', path: '/custom_url', value: 'https://evil.invalid' },
      ]),
    ).toThrow('read-only');
  });

  test('preserves marker semantics and all built-ins', () => {
    const base = createDefaultPreset();
    const history = base.prompts!.findIndex((prompt) => prompt.identifier === 'chatHistory');

    expect(() =>
      applyPresetPatch(base, [{ op: 'add', path: `/prompts/${history}/content`, value: 'fake' }]),
    ).toThrow('marker');
    expect(() => applyPresetPatch(base, [{ op: 'remove', path: `/prompts/${history}` }])).toThrow(
      'built-in',
    );
  });

  test('preserves the legacy 100000 order byte-for-byte', () => {
    const base = createDefaultPreset();
    base.prompt_order!.unshift({
      character_id: PROMPT_ORDER_LEGACY_ID,
      order: [{ identifier: 'main', enabled: true }],
    });

    expect(() =>
      applyPresetPatch(base, [
        { op: 'replace', path: '/prompt_order/0/order/0/enabled', value: false },
      ]),
    ).toThrow('legacy');
  });

  test('requires test operations to match before any changes commit', () => {
    const base = createDefaultPreset();
    expect(() =>
      applyPresetPatch(base, [
        { op: 'test', path: '/temperature', value: 99 },
        { op: 'replace', path: '/temperature', value: 0.5 },
      ]),
    ).toThrow('test failed');
    expect(base.temperature).toBe(1);
  });

  test('validates manual whole-JSON edits against the same boundary', () => {
    const base = createDefaultPreset();
    const edited = structuredClone(base);
    edited.prompts![0]!.content = 'Changed manually';
    edited.extensions = { custom: { kept: true } };

    expect(validatePresetDraft(edited, base)).toEqual(edited);
    expect(diffPreset(base, edited)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/prompts/0/content', kind: 'replace' }),
        expect.objectContaining({ path: '/extensions', kind: 'add' }),
      ]),
    );
  });

  test('rejects duplicate prompt identities and broken live orders', () => {
    const base = createDefaultPreset();
    const duplicate = structuredClone(base);
    duplicate.prompts!.push(structuredClone(duplicate.prompts![0]!));
    expect(() => validatePresetDraft(duplicate, base)).toThrow('duplicate prompt');

    const broken = structuredClone(base);
    broken.prompt_order![0]!.order[0]!.identifier = 'missing';
    expect(() => validatePresetDraft(broken, base)).toThrow('unknown prompt');
  });
});
