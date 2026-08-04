import { expect, test } from 'bun:test';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import { measureCard } from './budget.ts';

const counter: TokenCounter = {
  countText: (text) => text.trim().split(/\s+/).filter(Boolean).length,
  countChat: () => 0,
};

const data: CardDataV2 = {
  name: 'Nova',
  description: 'two words',
  personality: 'one',
  scenario: 'three words here',
  first_mes: 'hello there',
  mes_example: 'example one two',
  creator_notes: 'private note',
  system_prompt: 'system text',
  post_history_instructions: 'post history text',
  alternate_greetings: ['alternate hello', 'another greeting here'],
  group_only_greetings: ['group hello'],
  tags: [],
  creator: '',
  character_version: '',
  extensions: { depth_prompt: { depth: 4, prompt: 'depth words', role: 'system' } },
  character_book: {
    extensions: {},
    entries: [
      {
        keys: [],
        content: 'always on lore',
        extensions: {},
        enabled: true,
        insertion_order: 1,
        constant: true,
      },
      {
        keys: [],
        content: 'disabled constant lore',
        extensions: {},
        enabled: false,
        insertion_order: 2,
        constant: true,
      },
      {
        keys: ['keyword'],
        content: 'conditional lore',
        extensions: {},
        enabled: true,
        insertion_order: 3,
      },
    ],
  },
};

test('measureCard separates permanent, greeting, and constant lore costs', () => {
  const budget = measureCard(data, counter);

  expect(budget.fields.description).toBe(2);
  expect(budget.fields['alternate_greetings.1']).toBe(3);
  expect(budget.fields['group_only_greetings.0']).toBe(2);
  expect(budget.fields.depth_prompt).toBe(2);
  expect(budget.permanent).toBe(14);
  expect(budget.greeting).toBe(2);
  expect(budget.lorebookConstant).toBe(3);
  expect(budget.total).toBe(19);
});
