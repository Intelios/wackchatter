import { describe, expect, test } from 'bun:test';
import { assistantPlaceholder, type MessageState, userMessage } from '@shared/chat/message.ts';
import { emptyStash, setSlot } from '@shared/cocreator/stash.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { StashProvenance } from '@shared/types/cocreator.ts';
import { ANALYSE_EXAMPLES_REQUEST, buildDesignPrompt, isAnalyseRequest } from './prompt.ts';
import { renderDraftBlock } from './seed.ts';

/** One token per word, plus a fixed envelope per message and one for reply priming. */
const words: TokenCounter = {
  countText: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
  countChat: (messages) =>
    messages.reduce((total, message) => total + words.countText(message.content) + 1, 1),
};

function user(id: string, text: string): MessageState {
  return userMessage(id, 'You', text, null);
}

function assistant(id: string, text: string): MessageState {
  const message = assistantPlaceholder(id, 'Design assistant');
  return { ...message, swipes: [text] };
}

function build(
  messages: MessageState[],
  overrides: Partial<Parameters<typeof buildDesignPrompt>[0]> = {},
) {
  return buildDesignPrompt({
    systemPrompt: 'You are a design partner.',
    exampleBlock: '',
    messages,
    countTokens: words,
    maxPromptTokens: 1000,
    ...overrides,
  });
}

describe('assembling the design prompt', () => {
  test('with no examples there is exactly one system message', () => {
    const prompt = build([user('a', 'Hello.')]);

    expect(prompt.messages).toEqual([
      { role: 'system', content: 'You are a design partner.' },
      { role: 'user', content: 'Hello.' },
    ]);
  });

  test('examples share the only system message with the instructions', () => {
    const prompt = build([user('a', 'Hello.')], { exampleBlock: 'Example cards follow.' });

    expect(prompt.messages).toEqual([
      { role: 'system', content: 'You are a design partner.\n\nExample cards follow.' },
      { role: 'user', content: 'Hello.' },
    ]);
  });

  test('a blank system prompt contributes no message at all', () => {
    const prompt = build([user('a', 'Hi.')], { systemPrompt: '   ' });

    expect(prompt.messages).toEqual([{ role: 'user', content: 'Hi.' }]);
  });

  test('roles map from is_user, and no name is ever set', () => {
    const prompt = build([user('a', 'Give me a name.'), assistant('b', 'Elowen.')]);

    expect(prompt.messages.slice(1)).toEqual([
      { role: 'user', content: 'Give me a name.' },
      { role: 'assistant', content: 'Elowen.' },
    ]);
    for (const message of prompt.messages) expect('name' in message).toBe(false);
  });

  test('the blank placeholder is excluded, so a reply is not in its own prompt', () => {
    const prompt = build([
      user('a', 'Write a greeting.'),
      assistantPlaceholder('b', 'Design assistant'),
    ]);

    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages.at(-1)).toEqual({ role: 'user', content: 'Write a greeting.' });
  });

  test('whitespace-only turns are excluded too', () => {
    const prompt = build([user('a', 'Hi.'), assistant('b', '   \n  ')]);

    expect(prompt.messages).toHaveLength(2);
  });

  test('token counts add up to the total', () => {
    const prompt = build([user('a', 'one two three'), assistant('b', 'four five')], {
      exampleBlock: 'six seven eight nine',
    });
    const { system, examples, transcript } = prompt.tokenCounts;
    const replyPriming = words.countChat([]);

    expect(system + examples + transcript + replyPriming).toBe(prompt.totalTokens);
  });

  test.each([
    ['', '', ''],
    ['Instructions.', '', ''],
    ['', 'Examples.', ''],
    ['', '', 'Accepted card.'],
    ['Instructions.', 'Examples.', ''],
    ['Instructions.', '', 'Accepted card.'],
    ['', 'Examples.', 'Accepted card.'],
    ['Instructions.', 'Examples.', 'Accepted card.'],
  ])('merged block accounting for %j / %j / %j', (systemPrompt, exampleBlock, draftBlock) => {
    const counter: TokenCounter = {
      countText: (text) => Math.ceil(text.length / 4),
      countChat: (messages) =>
        messages.reduce((total, message) => total + counter.countText(message.content) + 4, 3),
    };
    const input = { systemPrompt, exampleBlock, draftBlock, countTokens: counter };
    const prompt = build([], input);
    const parts = [systemPrompt, exampleBlock, draftBlock].filter((block) => block.trim());
    expect(prompt.messages).toEqual(
      parts.length ? [{ role: 'system', content: parts.join('\n\n') }] : [],
    );
    expect(
      Object.values(prompt.tokenCounts).reduce((total, tokens) => total + tokens, 0) +
        counter.countChat([]),
    ).toBe(prompt.totalTokens);
    expect(build([], { ...input, maxPromptTokens: prompt.totalTokens }).fixedOverflow).toBe(false);
    expect(build([], { ...input, maxPromptTokens: prompt.totalTokens - 1 }).fixedOverflow).toBe(
      true,
    );
  });
});

describe('the assistant sees the accepted working card', () => {
  const provenance: StashProvenance = {
    messageId: 'b',
    swipeIndex: 0,
    at: '2026-08-13T10:00:00.000Z',
    source: 'block',
  };

  test('accepted and manually edited fields reach the prompt as literal card context', () => {
    let stash = emptyStash();
    stash = setSlot(stash, 'description', 'UNIQUESTASHMARKER description', provenance);
    stash = setSlot(stash, 'first_mes', 'UNIQUESTASHMARKER greeting', provenance);
    stash = setSlot(stash, 'tags', 'UNIQUESTASHMARKER', provenance);

    const messages = [user('a', 'Hello.'), assistant('b', 'Hi.')];
    const prompt = build(messages, { draftBlock: renderDraftBlock(stash, null) });
    expect(JSON.stringify(prompt.messages)).toContain('UNIQUESTASHMARKER description');
    expect(JSON.stringify(prompt.messages)).toContain('UNIQUESTASHMARKER greeting');
    expect(Object.keys(stash)).toContain('description');
  });

  test('the live card remains pinned when older suggestions fall out of context', () => {
    const prompt = build([user('old', 'old suggestion '.repeat(50)), user('new', 'Help')], {
      draftBlock: 'Current card {{char}}',
      maxPromptTokens: 25,
    });
    expect(prompt.messages[0]?.content).toContain('Current card {{char}}');
    expect(prompt.droppedMessages).toBe(1);
    expect(prompt.tokenCounts.draft).toBeGreaterThan(0);
    const { system, examples, draft, transcript } = prompt.tokenCounts;
    expect(system + examples + draft + transcript + words.countChat([])).toBe(prompt.totalTokens);
    expect(
      build([user('new', 'Help')], { draftBlock: 'Card '.repeat(50), maxPromptTokens: 25 })
        .fixedOverflow,
    ).toBe(true);
  });
});

describe('context budget', () => {
  function longConversation(turns: number): MessageState[] {
    return Array.from({ length: turns }, (_, i) =>
      i % 2 === 0 ? user(`u${i}`, `user turn ${i}`) : assistant(`a${i}`, `assistant turn ${i}`),
    );
  }

  test('everything fits when the budget is generous', () => {
    const prompt = build(longConversation(10), { maxPromptTokens: 1000 });

    expect(prompt.droppedMessages).toBe(0);
    expect(prompt.messages).toHaveLength(11);
    expect(prompt.fixedOverflow).toBe(false);
  });

  test('the oldest turns drop first and are counted', () => {
    const prompt = build(longConversation(10), { maxPromptTokens: 30 });

    expect(prompt.droppedMessages).toBeGreaterThan(0);
    expect(prompt.totalTokens).toBeLessThanOrEqual(30);
    // The newest turn always survives; the oldest is the one that went.
    expect(prompt.messages.at(-1)!.content).toBe('assistant turn 9');
    expect(JSON.stringify(prompt.messages)).not.toContain('user turn 0');
  });

  test('dropped plus kept accounts for every visible turn', () => {
    const prompt = build(longConversation(10), { maxPromptTokens: 30 });
    const kept = prompt.messages.filter((message) => message.role !== 'system').length;

    expect(kept + prompt.droppedMessages).toBe(10);
  });

  test('the system prompt and examples are pinned, never trimmed', () => {
    const prompt = build(longConversation(10), {
      exampleBlock: 'a b c d e f g h i j',
      maxPromptTokens: 30,
    });

    expect(prompt.messages[0]).toEqual({
      role: 'system',
      content: 'You are a design partner.\n\na b c d e f g h i j',
    });
  });

  test('pinned content alone over budget reports overflow rather than a partial pack', () => {
    const prompt = build(longConversation(4), {
      exampleBlock: Array.from({ length: 50 }, (_, i) => `word${i}`).join(' '),
      maxPromptTokens: 20,
    });

    expect(prompt.fixedOverflow).toBe(true);
    expect(prompt.droppedMessages).toBe(4);
    expect(prompt.messages.every((message) => message.role === 'system')).toBe(true);
  });

  test('an empty transcript is not an error', () => {
    const prompt = build([]);

    expect(prompt.messages).toHaveLength(1);
    expect(prompt.droppedMessages).toBe(0);
  });
});

describe('the analyse request', () => {
  test('it names what verification needs: every card, then what they share', () => {
    expect(ANALYSE_EXAMPLES_REQUEST).toContain('List every example card');
    expect(ANALYSE_EXAMPLES_REQUEST).toContain('Do not write any card fields yet');
  });

  test('it is recognisable in a transcript, so the panel can say it was already asked', () => {
    expect(isAnalyseRequest(`  ${ANALYSE_EXAMPLES_REQUEST}\n`)).toBe(true);
    expect(isAnalyseRequest('analyse the examples please')).toBe(false);
  });
});
