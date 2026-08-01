import { describe, expect, test } from 'bun:test';
import type { ApiMessage } from '@shared/types/chat.ts';
import { approximateChatTokens, encodingForModel, loadCounter } from './tokenizer.ts';

const CHAT: ApiMessage[] = [
  { role: 'system', content: 'You are Seraphina.' },
  { role: 'user', content: 'Hello there.', name: 'Jack' },
  { role: 'assistant', content: 'Well met, traveller.' },
];

describe('encodingForModel', () => {
  test('an override wins over the model id', () => {
    expect(encodingForModel('gpt-4o', 'cl100k_base')).toBe('cl100k_base');
  });

  test('the vendor prefix on an OpenRouter id is ignored', () => {
    expect(encodingForModel('openai/gpt-4o-mini')).toBe('o200k_base');
  });

  test('an unrecognised model falls back to cl100k', () => {
    expect(encodingForModel('cohere/north-mini-code:free')).toBe('cl100k_base');
  });
});

describe('loadCounter', () => {
  // The regression this guards: countChat used to delegate to gpt-tokenizer's chat
  // helper, which needs a model name the encoding modules do not carry. It threw
  // "Model name must be provided" on every call, and because assemblePrompt counts
  // chats unconditionally, every generation died before it reached the provider.
  for (const encoding of ['cl100k_base', 'o200k_base'] as const) {
    test(`${encoding} counts a chat without a model name`, async () => {
      const counter = await loadCounter(encoding);

      expect(counter.countChat(CHAT)).toBeGreaterThan(0);
      expect(counter.countText('Hello there.')).toBeGreaterThan(0);
    });

    test(`${encoding} charges the ChatML envelope assembly budgets against`, async () => {
      const counter = await loadCounter(encoding);

      // assemblePrompt takes countChat([]) as the reply priming and subtracts it to price
      // one message, so both have to hold for budgeting to mean anything.
      expect(counter.countChat([])).toBe(3);
      expect(counter.countChat(CHAT)).toBeGreaterThan(counter.countChat(CHAT.slice(0, 2)));
    });
  }

  test('the estimate is in the same ballpark as the real encoding', async () => {
    const counter = await loadCounter('cl100k_base');
    const exact = counter.countChat(CHAT);
    const estimate = approximateChatTokens(CHAT);

    // The estimate is deliberately biased high; it must never come in under the truth,
    // or the context budget it guards would be overrun.
    expect(estimate).toBeGreaterThanOrEqual(exact);
    expect(estimate).toBeLessThan(exact * 2);
  });
});
