import { describe, expect, test } from 'bun:test';
import { normalizeNexusSettings } from './settings.ts';
import { DEFAULT_NEXUS } from './types.ts';

describe('normalizeNexusSettings', () => {
  test('keeps a valid placement untouched', () => {
    const s = normalizeNexusSettings({
      template: '[Story knowledge.\n{{memories}}]',
      position: 'atDepth',
      depth: 4,
      role: 'user',
    });
    expect(s.template).toBe('[Story knowledge.\n{{memories}}]');
    expect(s.position).toBe('atDepth');
    expect(s.depth).toBe(4);
    expect(s.role).toBe('user');
  });

  test('clamps and floors depth into 0..100', () => {
    expect(normalizeNexusSettings({ depth: -4 }).depth).toBe(0);
    expect(normalizeNexusSettings({ depth: 1e9 }).depth).toBe(100);
    expect(normalizeNexusSettings({ depth: 2.7 }).depth).toBe(2);
  });

  test('unknown position and role fall back to the defaults', () => {
    const s = normalizeNexusSettings({ position: 'middle', role: 'narrator' });
    expect(s.position).toBe(DEFAULT_NEXUS.position);
    expect(s.role).toBe(DEFAULT_NEXUS.role);
  });

  test('a valid reasoning effort is kept, an unknown one falls back', () => {
    expect(normalizeNexusSettings({ reasoningEffort: 'auto' }).reasoningEffort).toBe('auto');
    expect(normalizeNexusSettings({ reasoningEffort: 'high' }).reasoningEffort).toBe('high');
    expect(normalizeNexusSettings({ reasoningEffort: 'lazy' }).reasoningEffort).toBe(
      DEFAULT_NEXUS.reasoningEffort,
    );
  });

  test('a template of the wrong type falls back, a string never validates macros', () => {
    expect(normalizeNexusSettings({ template: 42 }).template).toBe(DEFAULT_NEXUS.template);
    expect(normalizeNexusSettings({ template: 'no macro at all' }).template).toBe(
      'no macro at all',
    );
  });

  test('garbage input yields the defaults', () => {
    expect(normalizeNexusSettings(undefined)).toEqual(DEFAULT_NEXUS);
    expect(normalizeNexusSettings(null)).toEqual(DEFAULT_NEXUS);
    expect(normalizeNexusSettings('nexus')).toEqual(DEFAULT_NEXUS);
  });

  test('other fields keep their own rules', () => {
    const s = normalizeNexusSettings({ connectionId: '', autoInterval: 9999, motion: false });
    expect(s.connectionId).toBeNull();
    expect(s.autoInterval).toBe(2000);
    expect(s.motion).toBe(false);
  });

  test('the context allowance is not capped — modern models run to a million and beyond', () => {
    expect(normalizeNexusSettings({ inputTokens: 1_000_000 }).inputTokens).toBe(1_000_000);
    expect(normalizeNexusSettings({ inputTokens: 4_194_304 }).inputTokens).toBe(4_194_304);
    // Still floored, and garbage of the wrong type still falls back.
    expect(normalizeNexusSettings({ inputTokens: 1 }).inputTokens).toBe(2048);
    expect(normalizeNexusSettings({ inputTokens: 'lots' }).inputTokens).toBe(
      DEFAULT_NEXUS.inputTokens,
    );
  });
});
