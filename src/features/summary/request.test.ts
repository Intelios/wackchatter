import { describe, expect, test } from 'bun:test';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import { DEFAULT_SUMMARY } from '@shared/types/settings.ts';
import {
  linesThatFit,
  summaryCast,
  summaryInstructions,
  summaryMessages,
  summaryPreset,
  transcriptLines,
} from './request.ts';

const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const counter: TokenCounter = {
  countText: words,
  countChat: (messages) => messages.reduce((sum, m) => sum + words(m.content), 0),
};

const msg = (id: string, user: boolean, mes: string): ChatMessage => ({
  id,
  name: user ? 'Wren' : 'Mika',
  is_user: user,
  is_system: false,
  mes,
  send_date: '',
});

const cast = summaryCast(
  {
    name: 'Mika',
    description: '{{char}} runs the bookshop. She likes {{user}}.',
    scenario: 'A foggy town.',
  },
  { name: 'Wren', description: 'New in town.' },
  'User',
);

describe('the summary request', () => {
  test('carries its instructions, the cast, the memory so far and the new chat, and no preset', () => {
    expect(cast.charText).toBe(
      'Mika runs the bookshop. She likes Wren.\n\nScenario: A foggy town.',
    );
    const instructions = summaryInstructions(
      'Memory of {{user}} and {{char}}, {{words}} words.',
      700,
      cast,
    );
    expect(instructions).toBe('Memory of Wren and Mika, 700 words.');
    const messages = summaryMessages({
      instructions,
      cast,
      memory: '## Who’s who\n- Mika',
      lines: ['Wren: hi', 'Mika: hello'],
    });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]?.content).toContain(
      '<memory_so_far>\n## Who’s who\n- Mika\n</memory_so_far>',
    );
    expect(messages[1]?.content).toContain('<new_chat>\nWren: hi\n\nMika: hello\n</new_chat>');
    expect(summaryMessages({ instructions, cast, memory: '', lines: [] })[1]?.content).toContain(
      'There is no memory yet.',
    );
  });

  test('prompt-side regex runs over the chat; a line it empties is left out', () => {
    const strip: RegexScript = {
      id: 'r',
      scriptName: 'Strip status',
      findRegex: '/<status>[\\s\\S]*?<\\/status>/g',
      replaceString: '',
      trimStrings: [],
      placement: [2],
      disabled: false,
      markdownOnly: false,
      promptOnly: true,
      runOnEdit: false,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    } as RegexScript;
    const lines = transcriptLines(
      [
        msg('a', true, 'Hello'),
        msg('b', false, 'Hi <status>HP 10</status>'),
        msg('c', false, '<status>x</status>'),
      ],
      [strip],
    );
    expect(lines.map((l) => l.line)).toEqual(['Wren: Hello', 'Mika: Hi']);
  });

  test('a chunk is as many lines as fit the budget', () => {
    const build = (lines: readonly string[]) =>
      summaryMessages({ instructions: 'Summarise.', cast, memory: '', lines });
    const lines = Array.from({ length: 50 }, (_, i) => `Mika: line number ${i}`);
    const fixed = counter.countChat(build([]));
    expect(linesThatFit({ lines, budget: fixed + 20, counter, build })).toBe(3);
    expect(linesThatFit({ lines, budget: fixed, counter, build })).toBe(0);
  });

  test('its samplers are its own', () => {
    const preset = summaryPreset({
      ...DEFAULT_SUMMARY,
      temperature: 0.2,
      topP: 0.9,
      contextTokens: 16000,
    });
    expect([preset.temperature, preset.top_p, preset.openai_max_context]).toEqual([
      0.2, 0.9, 16000,
    ]);
  });
});
