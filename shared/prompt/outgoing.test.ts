import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '../types/card.ts';
import { createDefaultPreset } from './defaults.ts';
import { resolveOutgoingMacros } from './outgoing.ts';

const character: CardDataV2 = {
  name: 'Sera',
  description: '',
  personality: '',
  scenario: 'The forest',
  first_mes: '',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  tags: [],
  creator: '',
  character_version: '',
  extensions: {},
};

const base = { character, preset: createDefaultPreset(), messages: [] };

describe('resolving a draft', () => {
  test('expands identity macros against the current persona', () => {
    const result = resolveOutgoingMacros('{{user}} looks at {{char}}', {
      ...base,
      persona: { id: 'p', name: 'Ari', description: '', avatar: null },
    });
    expect(result.text).toBe('Ari looks at Sera');
  });

  /*
   * The point of the whole module. Assembly re-substitutes stored messages on every
   * request, so an unresolved roll is a different number in every swipe — and the
   * transcript shows none of them.
   */
  test('a dice roll becomes a number, once', () => {
    const result = resolveOutgoingMacros('I swing: {{roll:1d20}}', base);
    const value = Number(/I swing: (\d+)/.exec(result.text)?.[1]);
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(20);
    expect(result.text).not.toContain('{{');
  });

  test('an unknown macro survives as text rather than vanishing', () => {
    expect(resolveOutgoingMacros('{{notARealMacro}}', base).text).toBe('{{notARealMacro}}');
  });
});

describe('variable effects', () => {
  test('reports the new maps without mutating the ones it was given', () => {
    const local = { count: 1 };
    const global = { label: 'G' };

    const result = resolveOutgoingMacros(
      '{{incvar::count}} {{setglobalvar::label::changed}}{{getglobalvar::label}}',
      { ...base, metadata: { variables: local }, globalVariables: global },
    );

    expect(result.text).toBe('2 changed');
    expect(result.localChanged).toBe(true);
    expect(result.globalChanged).toBe(true);
    expect(result.local).toEqual({ count: 2 });
    expect(result.global).toEqual({ label: 'changed' });
    // The caller commits. Writing through would persist a send that never happened.
    expect(local).toEqual({ count: 1 });
    expect(global).toEqual({ label: 'G' });
  });

  test('a draft that reads variables without writing reports no change', () => {
    const result = resolveOutgoingMacros('HP: {{getvar::hp}}', {
      ...base,
      metadata: { variables: { hp: 10 } },
    });
    expect(result.text).toBe('HP: 10');
    expect(result.localChanged).toBe(false);
    expect(result.globalChanged).toBe(false);
  });

  /*
   * `{{setvar}}` alone resolves to nothing at all, which is what makes the composer usable
   * as a place to set a variable — the caller reads the empty result and appends no message.
   */
  test('a draft that is only a write resolves to nothing', () => {
    const result = resolveOutgoingMacros('{{setvar::hp::10}}', base);
    expect(result.text).toBe('');
    expect(result.localChanged).toBe(true);
    expect(result.local).toEqual({ hp: 10 });
  });
});
