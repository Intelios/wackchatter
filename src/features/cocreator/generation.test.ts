import { describe, expect, test } from 'bun:test';
import { assistantPlaceholder, setText, userMessage } from '@shared/chat/message.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildDesignGeneration } from './generation.ts';

const counter: TokenCounter = {
  countText: (text) => text.length,
  countChat: (messages) => messages.reduce((sum, message) => sum + message.content.length + 4, 3),
};
const request = {
  preset: createDefaultPreset(),
  connection: {
    id: 'test',
    name: 'Test',
    provider: 'custom' as const,
    model: 'model',
    baseUrl: 'http://localhost',
  },
  settings: {},
  systemPrompt: 'Design partner.',
  exampleBlock: '',
  countTokens: counter,
  streaming: true,
};
const user = userMessage('u', 'You', 'Write the character.', null);
const cutoff = setText(
  assistantPlaceholder('a', 'Assistant'),
  '````card:description\nA keeper who',
  { extra: { truncated: true } },
);

describe('design generation requests and recovery', () => {
  test('side generation includes frozen background while an ordinary main request never includes side history', () => {
    const sideSnapshot = {
      capturedAt: 1,
      systemPrompt: 'Frozen instructions.',
      exampleBlock: '',
      messages: [{ role: 'user' as const, content: 'Her favourite bird is a puffin.' }],
    };
    const messages = [
      userMessage('side-user', 'You', 'Side-only question.', null),
      assistantPlaceholder('side-reply', 'Assistant'),
    ];
    const side = buildDesignGeneration({ ...request, mode: 'send', messages, sideSnapshot });
    expect(side.body.messages.some((m) => m.content.includes('puffin'))).toBe(true);
    expect(side.body.messages.at(-1)?.content).toBe('Side-only question.');
    const main = buildDesignGeneration({ ...request, mode: 'send', messages: [user] });
    expect(JSON.stringify(main.body.messages)).not.toContain('Side-only');
    expect(JSON.stringify(main.body.messages)).not.toContain('Frozen instructions');
  });

  test('side overflow rejects both an oversized latest question and a continuation that drops its source', () => {
    const sideSnapshot = { capturedAt: 1, systemPrompt: 'Frozen.', exampleBlock: '', messages: [] };
    const huge = userMessage('huge-side', 'You', 'x'.repeat(20000), null);
    expect(() =>
      buildDesignGeneration({
        ...request,
        mode: 'send',
        messages: [huge],
        sideSnapshot,
        settings: { outputTokens: 1, contextTokens: 16384 },
      }),
    ).toThrow('latest side message');
    expect(() =>
      buildDesignGeneration({
        ...request,
        mode: 'continue',
        messages: [user, setText(cutoff, 'x'.repeat(20000))],
        sideSnapshot,
        settings: { outputTokens: 1, contextTokens: 16384 },
      }),
    ).toThrow('latest side message');
  });
  test('a send reserves reasoning room and replaces the chat preset’s tiny reply limit', () => {
    const result = buildDesignGeneration({
      ...request,
      mode: 'send',
      messages: [user, assistantPlaceholder('a', 'Assistant')],
    });
    expect(result.body.max_tokens).toBe(16384);
    expect(result.body.messages.at(-1)).toEqual({ role: 'user', content: 'Write the character.' });
    expect(result.prefix).toBe('');
  });

  test('continuation sends the exact partial card block and requests its remainder', () => {
    const result = buildDesignGeneration({
      ...request,
      mode: 'continue',
      messages: [user, cutoff],
    });
    expect(result.prefix).toBe('````card:description\nA keeper who');
    expect(result.body.messages.at(-2)).toEqual({ role: 'assistant', content: result.prefix });
    expect(result.body.messages.at(-1)?.role).toBe('user');
    expect(result.body.messages.at(-1)?.content).toContain('closing fence');
    // The input objects are the durable original take, and must remain untouched.
    expect(cutoff.swipes).toEqual([result.prefix]);
  });

  test('an oversized latest instruction is rejected, never sent with its content missing', () => {
    const huge = userMessage('big', 'You', 'x'.repeat(9000), null);
    expect(() =>
      buildDesignGeneration({
        ...request,
        mode: 'send',
        messages: [huge],
        settings: { outputTokens: 1, contextTokens: 16384 },
      }),
    ).toThrow('latest message');
  });

  test('continuation refuses a budget that drops the text being continued', () => {
    const huge = setText(cutoff, 'x'.repeat(9000));
    expect(() =>
      buildDesignGeneration({
        ...request,
        mode: 'continue',
        messages: [user, huge],
        settings: { outputTokens: 1, contextTokens: 16384 },
      }),
    ).toThrow('latest message');
  });
});
