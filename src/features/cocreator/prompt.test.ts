import { describe, expect, test } from 'bun:test';
import { assistantPlaceholder, type MessageState, userMessage } from '@shared/chat/message.ts';
import { emptyStash, setSlot } from '@shared/cocreator/stash.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { StashProvenance } from '@shared/types/cocreator.ts';
import {
  ANALYSE_EXAMPLES_REQUEST,
  buildDesignPrompt,
  isAnalyseRequest,
  renderStashRequest,
} from './prompt.ts';

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

  test('examples become a second system message, after the system prompt', () => {
    const prompt = build([user('a', 'Hello.')], { exampleBlock: 'Example cards follow.' });

    expect(prompt.messages.slice(0, 2)).toEqual([
      { role: 'system', content: 'You are a design partner.' },
      { role: 'system', content: 'Example cards follow.' },
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
});

describe('the stash never reaches the model on its own', () => {
  const provenance: StashProvenance = {
    messageId: 'b',
    swipeIndex: 0,
    at: '2026-08-13T10:00:00.000Z',
    source: 'block',
  };

  test('no stash value can change the assembled prompt', () => {
    let stash = emptyStash();
    stash = setSlot(stash, 'description', 'UNIQUESTASHMARKER description', provenance);
    stash = setSlot(stash, 'first_mes', 'UNIQUESTASHMARKER greeting', provenance);
    stash = setSlot(stash, 'tags', 'UNIQUESTASHMARKER', provenance);

    const messages = [user('a', 'Hello.'), assistant('b', 'Hi.')];
    const prompt = build(messages);

    // buildDesignPrompt takes no stash parameter at all — this asserts the consequence.
    expect(JSON.stringify(prompt.messages)).not.toContain('UNIQUESTASHMARKER');
    expect(Object.keys(stash)).toContain('description');
  });

  test('showing the model the stash produces text for a visible user turn', () => {
    const request = renderStashRequest([
      { label: 'Description', text: 'Tall and tired.' },
      { label: 'First message', text: 'The lamp room is cold.' },
    ]);

    expect(request).toContain('Description:\nTall and tired.');
    expect(request).toContain('First message:\nThe lamp room is cold.');
  });

  test('an empty stash still renders something sayable', () => {
    expect(renderStashRequest([])).toBe('Nothing is filed into the card yet.');
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

    expect(prompt.messages[0]).toEqual({ role: 'system', content: 'You are a design partner.' });
    expect(prompt.messages[1]).toEqual({ role: 'system', content: 'a b c d e f g h i j' });
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
