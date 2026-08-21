import { describe, expect, test } from 'bun:test';
import type { ChatMessage, Memory } from '../types/chat.ts';
import { DEFAULT_WI_SETTINGS } from '../types/worldinfo.ts';
import { memoryWorldInfoSource, recallMemories } from './source.ts';

function memory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    title: `Title ${id}`,
    text: `Body ${id}`,
    keywords: [],
    range: { startId: `s${id}`, endId: `e${id}` },
    pinned: false,
    enabled: true,
    source: 'generated',
    edited: false,
    generatedAt: 0,
    ...overrides,
  };
}

function message(id: string, mes: string): ChatMessage {
  return { id, name: 'Jack', is_user: true, is_system: false, mes, send_date: '' };
}

/** Word count stands in for a tokenizer; the engine only needs a monotonic measure. */
const countTokens = (text: string) => text.split(/\s+/).filter(Boolean).length;

function entries(memories: Memory[]) {
  return memoryWorldInfoSource(memories).book.entries;
}

describe('memoryWorldInfoSource', () => {
  test('fills the vacant chat source kind', () => {
    expect(memoryWorldInfoSource([memory('a')]).kind).toBe('chat');
  });

  test('a pinned memory becomes a constant entry with no keys', () => {
    const entry = entries([memory('a', { pinned: true, keywords: ['x'] })])['0'];
    expect(entry?.constant).toBe(true);
    expect(entry?.key).toEqual([]);
  });

  test('an unpinned memory carries its keywords as keys', () => {
    const entry = entries([memory('a', { keywords: ['cellar', 'Ilva'] })])['0'];
    expect(entry?.constant).toBe(false);
    expect(entry?.key).toEqual(['cellar', 'Ilva']);
  });

  test('the title becomes the entry memo, so the inspector can name it', () => {
    expect(entries([memory('a', { title: 'The Cellar' })])['0']?.comment).toBe('The Cellar');
  });

  test('disabled memories are absent entirely', () => {
    expect(Object.keys(entries([memory('a', { enabled: false }), memory('b')]))).toEqual(['1']);
  });

  test('uid is the index, which is how an activated entry maps back', () => {
    const book = entries([memory('a'), memory('b')]);
    expect(book['1']?.uid).toBe(1);
  });

  test('pinned memories outrank recalled ones when the budget runs short', () => {
    const book = entries([memory('a', { pinned: true }), memory('b')]);
    expect(book['0']!.order).toBeGreaterThan(book['1']!.order);
  });
});

describe('recallMemories', () => {
  const settings = { ...DEFAULT_WI_SETTINGS, depth: 5 };

  test('returns null when there is nothing enabled to recall', () => {
    expect(
      recallMemories({
        memories: [memory('a', { enabled: false })],
        messages: [message('m', 'anything')],
        settings,
        budget: 1000,
        countTokens,
      }),
    ).toBeNull();
  });

  test('pinned memories fire without a keyword; unkeyed ones do not', () => {
    const result = recallMemories({
      memories: [memory('pin', { pinned: true }), memory('quiet')],
      messages: [message('m', 'nothing relevant here')],
      settings,
      budget: 1000,
      countTokens,
    });
    expect(result?.recalled.map((m) => m.id)).toEqual(['pin']);
  });

  test('a keyword in recent chat wakes its memory', () => {
    const result = recallMemories({
      memories: [memory('cellar', { keywords: ['Ilva'] })],
      messages: [message('m', 'Tell me about Ilva.')],
      settings,
      budget: 1000,
      countTokens,
    });
    expect(result?.recalled.map((m) => m.id)).toEqual(['cellar']);
  });

  test('recalled memories are rendered in chat order, not activation order', () => {
    // A model shown a later scene first reads the ordering as meaningful.
    const result = recallMemories({
      memories: [
        memory('first', { title: 'First Meeting', keywords: ['treeline'] }),
        memory('later', { title: 'The Bargain', pinned: true }),
      ],
      messages: [message('m', 'back at the treeline')],
      settings,
      budget: 1000,
      countTokens,
    });
    expect(result?.recalled.map((m) => m.id)).toEqual(['first', 'later']);
    expect(result?.text.indexOf('First Meeting')).toBeLessThan(result!.text.indexOf('The Bargain'));
  });

  test('the budget is the memory budget, and exhausting it drops the lowest-ranked', () => {
    const result = recallMemories({
      memories: [memory('a', { pinned: true }), memory('b', { pinned: true })],
      messages: [message('m', 'hello')],
      settings,
      budget: 2,
      countTokens,
    });
    expect(result?.recalled.length).toBeLessThan(2);
    expect(result?.activation.budgetExhausted).toBe(true);
  });

  test('quotes reach the rendered text', () => {
    const result = recallMemories({
      memories: [memory('a', { pinned: true, quotes: ['You will want to be careful.'] })],
      messages: [message('m', 'hello')],
      settings,
      budget: 1000,
      countTokens,
    });
    expect(result?.text).toContain('"You will want to be careful."');
  });
});
