import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ApiMessage, ChatMessage } from '@shared/types/chat.ts';
import { CHARACTER_NAMES_BEHAVIOR } from '@shared/types/preset.ts';
import { assembleSummaryPrompt, summaryMessageCost } from './summaryPrompt.ts';

/** One token per word, plus one per message and one for the reply priming. */
const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const counter: TokenCounter = {
  countText: words,
  countChat: (messages: readonly ApiMessage[]) =>
    1 + messages.reduce((total, m) => total + 1 + words(m.content) + (m.name ? 1 : 0), 0),
};

const character: CardDataV2 = {
  name: 'Seraphina',
  description: 'A forest guardian.',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  tags: [],
  creator: '',
  character_version: '',
  extensions: {},
};

const message = (mes: string, is_user = true): ChatMessage => ({
  id: mes,
  name: is_user ? 'Tomas' : 'Seraphina',
  is_user,
  is_system: false,
  mes,
  send_date: '',
});

describe('summaryMessageCost', () => {
  test('prices a message as its marginal cost in the chat, without the reply priming', () => {
    const cost = summaryMessageCost(counter, createDefaultPreset());
    expect(cost(message('three short words'))).toBe(4);
  });

  test('names_behavior content prefixes the speaker, completion sends a name', () => {
    const content = summaryMessageCost(counter, {
      ...createDefaultPreset(),
      names_behavior: CHARACTER_NAMES_BEHAVIOR.CONTENT,
    });
    expect(content(message('hi'))).toBe(3);
    const completion = summaryMessageCost(counter, {
      ...createDefaultPreset(),
      names_behavior: CHARACTER_NAMES_BEHAVIOR.COMPLETION,
    });
    expect(completion(message('hi'))).toBe(3);
  });
});

describe('assembleSummaryPrompt', () => {
  const base = {
    chatId: 'c1',
    preset: createDefaultPreset(),
    character,
    persona: null,
    metadata: { persona: null },
    lore: null,
    localVariables: {},
    globalVariables: {},
    countTokens: counter,
    maxTokens: 100,
    systemPrompt: 'Summarise the story.',
  };

  test('the rolling summary, then the instruction, come last', () => {
    const result = assembleSummaryPrompt({
      ...base,
      candidate: [message('We reached the glade.')],
      baseSummary: 'They met in the forest.',
    });
    expect(result.ok).toBe(true);
    const tail = result.messages.slice(-2).map((m) => m.content);
    expect(tail[0]).toContain('They met in the forest.');
    expect(tail[1]).toBe('Summarise the story.');
  });

  test('with no summary yet there is no base control', () => {
    const result = assembleSummaryPrompt({
      ...base,
      candidate: [message('We reached the glade.')],
      baseSummary: '',
    });
    expect(result.messages.at(-1)?.content).toBe('Summarise the story.');
    expect(result.messages.at(-2)?.content).not.toContain('They met');
  });
});
