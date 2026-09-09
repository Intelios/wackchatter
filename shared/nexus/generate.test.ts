import { describe, expect, test } from 'bun:test';
import { nexusPreset, nexusRequestError } from './generate.ts';
import { DEFAULT_NEXUS } from './types.ts';

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
    expect(byUsage).toContain('entire output budget on reasoning');
    // Reasoning text proves it too, for providers that report no usage details.
    const byText = nexusRequestError({
      finishReason: 'length',
      content: '',
      reasoning: 'A plan of fourteen records…',
    });
    expect(byText).toContain('entire output budget on reasoning');
  });

  test('empty content without a length cut is its own error', () => {
    expect(nexusRequestError({ finishReason: 'stop', content: '', reasoning: '' })).toBe(
      'The memory model returned no content.',
    );
  });
});
