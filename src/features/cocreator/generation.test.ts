import { describe, expect, test } from 'bun:test';
import { blankCardData } from '@shared/card/blank.ts';
import { assistantPlaceholder, setText, userMessage } from '@shared/chat/message.ts';
import { captureSideSnapshot } from '@shared/cocreator/sideChat.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { DEFAULT_EXAMPLE_FIELDS } from '@shared/types/cocreator.ts';
import { renderExamples } from './examples.ts';
import { buildDesignGeneration } from './generation.ts';
import { renderDraftBlock, seedStash } from './seed.ts';
import { SIDE_CHAT_BOUNDARY, SIDE_CHAT_INSTRUCTION } from './sidePrompt.ts';

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
  const exampleNames = ['Seori', 'Mika', 'Niamh', 'Giselle', 'Sunhi', 'Rosie'];
  const exampleBlock = renderExamples(
    exampleNames.map((name) => ({
      avatar: `${name}.png`,
      card: {
        ...blankCardData(name),
        description: `${name} description {{char}}.`,
        first_mes: `${name} first message {{user}}.`,
        scenario: 'Unselected scenario.',
      },
    })),
    {
      ...DEFAULT_EXAMPLE_FIELDS,
      personality: false,
      scenario: false,
      tags: false,
    },
    counter,
  ).text;
  const existing = {
    avatar: 'Kohana.png',
    folder: '',
    name: 'Kohana',
    description: 'The existing character.',
    creator: '',
    tags: [],
    character_version: '',
    hasLorebook: false,
    modified: 0,
    card: {
      data: {
        ...blankCardData('Kohana'),
        description: 'Kohana accepted description.',
        first_mes: 'Kohana accepted first message.',
        alternate_greetings: ['Kohana alternate greeting.'],
      },
    },
  };
  const draftBlock = renderDraftBlock(seedStash(existing, ''), existing.card);

  test.each(['send', 'swipe', 'continue'] as const)(
    '%s keeps every example and the existing card in one system message',
    (mode) => {
      const result = buildDesignGeneration({
        ...request,
        mode,
        exampleBlock,
        draftBlock,
        messages: [user, mode === 'continue' ? cutoff : assistantPlaceholder('a', 'Assistant')],
      });
      const systems = result.body.messages.filter((m) => m.role === 'system');
      expect(systems).toHaveLength(1);
      expect(result.body.messages[0]).toBe(systems[0]!);
      expect(systems[0]!.content).toBe(
        [request.systemPrompt, exampleBlock, draftBlock].join('\n\n'),
      );
      for (const name of exampleNames) {
        expect(systems[0]!.content).toContain(`${name} description {{char}}.`);
        expect(systems[0]!.content).toContain(`${name} first message {{user}}.`);
      }
      expect(systems[0]!.content).not.toContain('Unselected scenario.');
      expect(systems[0]!.content).toContain('Kohana accepted description.');
      expect(systems[0]!.content).toContain('Kohana alternate greeting.');
    },
  );

  test.each(['send', 'swipe', 'continue'] as const)(
    'side %s keeps frozen examples and the card in the only system message',
    (mode) => {
      const sideSnapshot = captureSideSnapshot({
        systemPrompt: request.systemPrompt,
        exampleBlock,
        draftBlock,
        messages: [user],
      });
      const result = buildDesignGeneration({
        ...request,
        mode,
        sideSnapshot,
        messages: [user, mode === 'continue' ? cutoff : assistantPlaceholder('a', 'Assistant')],
      });
      const systems = result.body.messages.filter((m) => m.role === 'system');
      expect(systems).toHaveLength(1);
      expect(result.body.messages[0]).toBe(systems[0]!);
      expect(systems[0]!.content).toContain(request.systemPrompt);
      expect(systems[0]!.content).toContain(SIDE_CHAT_INSTRUCTION);
      expect(systems[0]!.content).toContain(exampleBlock);
      expect(systems[0]!.content).toContain(draftBlock);
      expect(result.body.messages.find((m) => m.content === SIDE_CHAT_BOUNDARY)?.role).toBe('user');
    },
  );
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
  test('a send carries no reply cap, whatever the chat preset says', () => {
    const result = buildDesignGeneration({
      ...request,
      mode: 'send',
      messages: [user, assistantPlaceholder('a', 'Assistant')],
    });
    expect(Object.hasOwn(result.body, 'max_tokens')).toBe(false);
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
