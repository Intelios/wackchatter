import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '../prompt/defaults.ts';
import { normalizePreset } from '../prompt/preset-io.ts';
import { DEFAULT_RESPONSE_TOKENS, responseCap, responseReserve } from './responseLength.ts';

describe('response length', () => {
  test('a capped preset caps and reserves the same number', () => {
    const preset = { openai_max_tokens: 700 };
    expect(responseCap(preset)).toBe(700);
    expect(responseReserve(preset)).toBe(700);
    expect(responseCap({})).toBe(DEFAULT_RESPONSE_TOKENS);
  });

  test('an unlimited preset caps nothing and reserves a share of the context', () => {
    expect(responseCap({ openai_max_tokens_unlimited: true, openai_max_tokens: 300 })).toBeNull();
    expect(responseReserve({ openai_max_tokens_unlimited: true, openai_max_context: 4096 })).toBe(
      1024,
    );
    expect(responseReserve({ openai_max_tokens_unlimited: true, openai_max_context: 200000 })).toBe(
      8192,
    );
  });

  test('presets made here start unlimited; imported ones keep their number', () => {
    expect(responseCap(createDefaultPreset())).toBeNull();
    const imported = normalizePreset({ openai_max_tokens: 450 });
    expect(responseCap(imported)).toBe(450);
  });
});
