import { describe, expect, test } from 'bun:test';
import { thinkingMaxTokens } from './thinking.ts';

const openai = { provider: 'custom', model: 'gpt-5' } as const;
const claude = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' } as const;

describe('thinkingMaxTokens', () => {
  const ask = (effort: Parameters<typeof thinkingMaxTokens>[0]['effort'], contextTokens = 1e6) =>
    thinkingMaxTokens({ outputTokens: 2048, contextTokens, effort, connection: openai });

  test('reasoning room rides on top of the output, sized by effort', () => {
    expect(ask('min')).toBe(2048 + 4096);
    expect(ask('auto')).toBe(2048 + 8192);
    expect(ask('max')).toBe(2048 + 65536);
  });

  test('the room never pushes past the declared context', () => {
    expect(ask('low', 8192)).toBe(8192 - 128);
    expect(ask('low', 1024)).toBe(2048);
  });

  test('Claude on OpenRouter gets the output alone; the request builder adds thinking', () => {
    expect(
      thinkingMaxTokens({
        outputTokens: 2048,
        contextTokens: 1e6,
        effort: 'high',
        connection: claude,
      }),
    ).toBe(2048);
  });
});
