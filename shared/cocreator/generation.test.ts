import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '../prompt/defaults.ts';
import { buildRequestBody } from '../providers/request.ts';
import type { Connection } from '../providers/types.ts';
import { cocreatorBudget } from './generation.ts';

const connection: Connection = {
  id: 'test',
  name: 'Test',
  provider: 'custom',
  baseUrl: 'http://localhost',
  model: 'reasoner',
};

describe('Co-Creator generation budget', () => {
  test('design output does not inherit a 300-token roleplay limit', () => {
    const budget = cocreatorBudget({ preset: createDefaultPreset(), connection });
    expect(budget.outputTokens).toBe(8192);
    expect(budget.maxTokens).toBe(16384);
    expect(budget.promptTokens + budget.reservedTokens).toBe(131072 - 128);
  });

  test('high reasoning gets room in addition to visible output', () => {
    const budget = cocreatorBudget({
      preset: { ...createDefaultPreset(), reasoning_effort: 'high' },
      connection,
      outputTokens: 4096,
      contextTokens: 65536,
    });
    expect(budget.maxTokens).toBe(4096 + 32768);
    expect(budget.promptTokens).toBe(65536 - 128 - budget.maxTokens);
  });

  test('reserves the actual Claude request including its separate thinking budget', () => {
    const preset = { ...createDefaultPreset(), reasoning_effort: 'high' as const };
    const claude = {
      ...connection,
      provider: 'openrouter' as const,
      model: 'anthropic/claude-sonnet-4',
    };
    const budget = cocreatorBudget({ preset, connection: claude, outputTokens: 8192 });
    const body = buildRequestBody({
      preset,
      connection: claude,
      messages: [],
      stream: true,
      maxTokens: budget.maxTokens,
    });
    expect(budget.maxTokens).toBe(8192);
    expect(budget.reservedTokens).toBe(Number(body.max_tokens));
    expect(budget.reservedTokens).toBeGreaterThan(budget.outputTokens);
  });

  test('a context too small for the requested reply fails before spending on a request', () => {
    expect(() =>
      cocreatorBudget({ preset: createDefaultPreset(), connection, contextTokens: 4096 }),
    ).toThrow('context');
  });
});
