import { describe, expect, test } from 'bun:test';
import type { ChatMessage, Memory } from '../types/chat.ts';
import {
  buildExtractionMessages,
  formatWindow,
  memoryBacklog,
  memoryMessages,
  parseMemoryResponse,
} from './extract.ts';

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    name: 'Sera',
    is_user: false,
    is_system: false,
    mes: `line ${id}`,
    send_date: '',
    ...overrides,
  };
}

const window = [message('a'), message('b'), message('c'), message('d')];

function reply(memories: unknown[]): string {
  return JSON.stringify({ memories });
}

const draft = {
  title: 'First Meeting',
  text: 'They met at the treeline.',
  keywords: ['Sera'],
  startIndex: 0,
  endIndex: 1,
};

describe('memoryMessages', () => {
  test('drops hidden and blank turns', () => {
    // Hidden messages are excluded for the same reason lore ignores them: a memory written
    // from one would put its content back in the prompt by proxy.
    const list = [
      message('a'),
      message('b', { is_system: true }),
      message('c', { mes: '   ' }),
      message('d'),
    ];
    expect(memoryMessages(list).map((m) => m.id)).toEqual(['a', 'd']);
  });
});

describe('memoryBacklog', () => {
  test('a missing watermark starts at the top', () => {
    expect(memoryBacklog(window).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('resumes after the watermark', () => {
    expect(memoryBacklog(window, 'b').map((m) => m.id)).toEqual(['c', 'd']);
  });

  test('a watermark naming a deleted message restarts rather than stranding the backlog', () => {
    expect(memoryBacklog(window, 'gone').map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('formatWindow', () => {
  test('numbers from zero and collapses newlines so the numbering stays unambiguous', () => {
    const list = [message('a', { mes: 'two\n\nlines' }), message('b', { name: 'Jack' })];
    expect(formatWindow(list)).toBe('[0] Sera: two lines\n[1] Jack: line b');
  });
});

describe('buildExtractionMessages', () => {
  const base = {
    extractPrompt: 'Archive this.',
    character: { name: 'Sera', description: 'A woodcutter.' },
    priorMemories: [] as Memory[],
    window,
  };

  test('carries the JSON contract even when the prompt was rewritten', () => {
    // The contract is appended by code, so editing the style guidance cannot break parsing.
    const messages = buildExtractionMessages({ ...base, extractPrompt: 'Do whatever.' });
    expect(messages[0]?.content).toContain('Do whatever.');
    expect(messages[0]?.content).toContain('"memories"');
  });

  test('omits the persona block when there is no persona', () => {
    const contents = buildExtractionMessages(base).map((m) => m.content);
    expect(contents.some((text) => text.includes('speaking with'))).toBe(false);
  });

  test('includes prior memories so the chain stays continuous', () => {
    const prior: Memory = {
      id: 'm1',
      title: 'First Meeting',
      text: 'Sera found him at the treeline.',
      keywords: [],
      range: { startId: 'a', endId: 'b' },
      pinned: false,
      enabled: true,
      source: 'generated',
      edited: false,
      generatedAt: 0,
    };
    const contents = buildExtractionMessages({ ...base, priorMemories: [prior] }).map(
      (m) => m.content,
    );
    expect(contents.some((text) => text.includes('Sera found him at the treeline.'))).toBe(true);
  });

  test('the transcript is the only user turn', () => {
    const messages = buildExtractionMessages(base);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.at(-1)?.content).toBe(formatWindow(window));
  });
});

describe('parseMemoryResponse', () => {
  test('reads a clean reply and maps indices to message ids', () => {
    const result = parseMemoryResponse(reply([draft]), window);
    expect(result.error).toBeUndefined();
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      title: 'First Meeting',
      startId: 'a',
      endId: 'b',
    });
  });

  test('survives a code fence and surrounding prose', () => {
    const text = `Here you go:\n\`\`\`json\n${reply([draft])}\n\`\`\`\nHope that helps.`;
    expect(parseMemoryResponse(text, window).memories).toHaveLength(1);
  });

  test('survives trailing commas', () => {
    const text =
      '{ "memories": [ { "title": "T", "text": "B", "startIndex": 0, "endIndex": 0, }, ] }';
    expect(parseMemoryResponse(text, window).memories).toHaveLength(1);
  });

  test('an empty list is a valid answer, not an error', () => {
    const result = parseMemoryResponse(reply([]), window);
    expect(result.error).toBeUndefined();
    expect(result.memories).toEqual([]);
  });

  test('unreadable output is reported rather than thrown', () => {
    expect(parseMemoryResponse('I cannot do that.', window).error).toBeDefined();
  });

  test('JSON without a memories list is reported', () => {
    expect(parseMemoryResponse('{"scenes": []}', window).error).toBeDefined();
  });

  test('drops entries with an out-of-range index rather than clamping into a neighbour', () => {
    const result = parseMemoryResponse(reply([{ ...draft, endIndex: 99 }]), window);
    expect(result.memories).toEqual([]);
  });

  test('drops inverted ranges', () => {
    expect(
      parseMemoryResponse(reply([{ ...draft, startIndex: 3, endIndex: 1 }]), window).memories,
    ).toEqual([]);
  });

  test('drops entries missing a title or body', () => {
    const result = parseMemoryResponse(
      reply([
        { ...draft, title: '  ' },
        { ...draft, text: '' },
      ]),
      window,
    );
    expect(result.memories).toEqual([]);
  });

  test('forces overlapping ranges apart so hiding stays attributable', () => {
    // Two memories claiming one message would make "delete this memory and get its
    // messages back" ambiguous, so the second is pushed past the first.
    const result = parseMemoryResponse(
      reply([
        { ...draft, startIndex: 0, endIndex: 2 },
        { ...draft, title: 'Second', startIndex: 1, endIndex: 3 },
      ]),
      window,
    );
    expect(result.memories.map((m) => [m.startId, m.endId])).toEqual([
      ['a', 'c'],
      ['d', 'd'],
    ]);
  });

  test('drops a later range swallowed entirely by an earlier one', () => {
    const result = parseMemoryResponse(
      reply([
        { ...draft, startIndex: 0, endIndex: 3 },
        { ...draft, title: 'Second', startIndex: 1, endIndex: 2 },
      ]),
      window,
    );
    expect(result.memories).toHaveLength(1);
  });

  test('caps and deduplicates keywords case-insensitively', () => {
    const result = parseMemoryResponse(
      reply([{ ...draft, keywords: ['Sera', 'sera', ' SERA ', 'cabin', 42] }]),
      window,
    );
    expect(result.memories[0]?.keywords).toEqual(['Sera', 'cabin']);
  });

  test('keeps at most two quotes', () => {
    const result = parseMemoryResponse(reply([{ ...draft, quotes: ['a', 'b', 'c'] }]), window);
    expect(result.memories[0]?.quotes).toEqual(['a', 'b']);
  });
});
