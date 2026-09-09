import { describe, expect, test } from 'bun:test';
import { nexusMaxTokens, nexusPreset, nexusRequestError } from './generate.ts';
import { DEFAULT_NEXUS } from './types.ts';

const openai = { provider: 'custom', model: 'gpt-5' } as const;
const claude = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' } as const;

describe('nexusPreset', () => {
  test('carries the Nexus settings onto the synthetic preset', () => {
    const preset = nexusPreset({
      ...DEFAULT_NEXUS,
      temperature: 0.7,
      inputTokens: 4096,
      outputTokens: 1024,
      reasoningEffort: 'medium',
    });
    expect(preset.temperature).toBe(0.7);
    expect(preset.openai_max_context).toBe(4096);
    expect(preset.openai_max_tokens).toBe(1024);
    expect(preset.reasoning_effort).toBe('medium');
    expect(preset.top_p).toBe(1);
    expect(preset.presence_penalty).toBe(0);
    expect(preset.frequency_penalty).toBe(0);
    expect(preset.stream_openai).toBe(false);
  });

  test('the default effort is low, so reasoning is asked for explicitly and kept small', () => {
    expect(nexusPreset(DEFAULT_NEXUS).reasoning_effort).toBe('low');
  });
});

describe('nexusMaxTokens', () => {
  test('reasoning rides on top of the output allowance, sized by effort', () => {
    const big = { ...DEFAULT_NEXUS, inputTokens: 1_000_000, outputTokens: 2048 };
    expect(nexusMaxTokens({ ...big, reasoningEffort: 'low' }, openai)).toBe(2048 + 8192);
    expect(nexusMaxTokens({ ...big, reasoningEffort: 'min' }, openai)).toBe(2048 + 4096);
    expect(nexusMaxTokens({ ...big, reasoningEffort: 'medium' }, openai)).toBe(2048 + 16384);
    expect(nexusMaxTokens({ ...big, reasoningEffort: 'high' }, openai)).toBe(2048 + 32768);
    expect(nexusMaxTokens({ ...big, reasoningEffort: 'max' }, openai)).toBe(2048 + 65536);
  });

  test('auto still buys headroom — the endpoint default effort is not nothing', () => {
    const s = { ...DEFAULT_NEXUS, inputTokens: 1_000_000 };
    expect(nexusMaxTokens({ ...s, reasoningEffort: 'auto' }, openai)).toBe(2048 + 8192);
  });

  test('the headroom never pushes the ask past the declared context', () => {
    // The default config: 8192 context, 2048 output — headroom clamps to the slack.
    expect(nexusMaxTokens(DEFAULT_NEXUS, openai)).toBe(8192 - 128);
    // A tight context with no slack at all still asks for the full reply budget.
    expect(nexusMaxTokens({ ...DEFAULT_NEXUS, inputTokens: 2048 }, openai)).toBe(2048);
    expect(nexusMaxTokens({ ...DEFAULT_NEXUS, inputTokens: 1024 }, openai)).toBe(2048);
  });

  test('Claude on OpenRouter asks for the reply alone — buildRequestBody adds its thinking budget', () => {
    const big = { ...DEFAULT_NEXUS, inputTokens: 1_000_000, outputTokens: 2048 };
    expect(nexusMaxTokens(big, claude)).toBe(2048);
  });

  test('a missing connection is treated like any other endpoint', () => {
    const big = { ...DEFAULT_NEXUS, inputTokens: 1_000_000, outputTokens: 2048 };
    expect(nexusMaxTokens(big, null)).toBe(2048 + 8192);
  });
});

describe('nexusRequestError', () => {
  test('a finished result with content is not an error', () => {
    expect(
      nexusRequestError({ finishReason: 'stop', content: '{"records":[]}', reasoning: '' }),
    ).toBeNull();
  });

  test('a length cut with text asks for a bigger allowance', () => {
    expect(
      nexusRequestError({ finishReason: 'length', content: '{"records"', reasoning: '' }),
    ).toBe(
      'The memory model reached its output limit. Increase the Nexus output allowance and retry.',
    );
  });

  test('a length cut that is nothing but reasoning says what actually happened', () => {
    const byUsage = nexusRequestError({
      finishReason: 'length',
      content: '',
      reasoning: '',
      usage: { reasoning_tokens: 2052 },
    });
    expect(byUsage).toContain('reasoned through its entire token budget');
    // Reasoning text proves it too, for providers that report no usage details.
    const byText = nexusRequestError({
      finishReason: 'length',
      content: '',
      reasoning: 'A plan of fourteen records…',
    });
    expect(byText).toContain('reasoned through its entire token budget');
  });

  test('empty content without a length cut is its own error', () => {
    expect(nexusRequestError({ finishReason: 'stop', content: '', reasoning: '' })).toBe(
      'The memory model returned no content.',
    );
  });
});
