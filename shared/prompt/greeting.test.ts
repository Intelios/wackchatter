import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '../types/card.ts';
import { createDefaultPreset } from './defaults.ts';
import { resolveGreetingMacros } from './greeting.ts';

const character: CardDataV2 = {
  name: 'Sera',
  description: '',
  personality: '',
  scenario: 'The forest',
  first_mes: 'Hello {{user}}',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: ['Welcome to {{scenario}}'],
  tags: [],
  creator: '',
  character_version: '',
  extensions: {},
};

describe('render-only greeting macros', () => {
  test('resolve against the current persona and explicit chat scenario', () => {
    expect(
      resolveGreetingMacros('{{char}} greets {{user}} in {{scenario}}: {{persona}}', {
        character,
        preset: createDefaultPreset(),
        persona: {
          id: 'p',
          name: 'Ari',
          description: 'A scholar',
          avatar: null,
        },
        messages: [],
        metadata: { scenario: 'The harbour' },
      }),
    ).toBe('Sera greets Ari in The harbour: A scholar');
  });

  test('simulates variable macros sequentially but discards their effects', () => {
    const local = { count: 1 };
    const global = { label: 'G' };
    const result = resolveGreetingMacros(
      '{{incvar::count}} {{setglobalvar::label::changed}}{{getglobalvar::label}}',
      {
        character,
        preset: createDefaultPreset(),
        messages: [],
        metadata: { variables: local },
        globalVariables: global,
      },
    );

    expect(result).toBe('2 changed');
    expect(local).toEqual({ count: 1 });
    expect(global).toEqual({ label: 'G' });
  });
});
