import { describe, expect, test } from 'bun:test';
import type { TokenCounter } from './token-cache.ts';
import { memoizeCounter } from './token-cache.ts';

/** A counter that records how often it was actually invoked. */
function tracking() {
  const calls: string[] = [];
  const counter: TokenCounter = {
    countText: (text) => {
      calls.push(text);
      return text.length;
    },
    countChat: (messages) => messages.length,
  };
  return { counter, calls };
}

describe('memoizeCounter', () => {
  test('a repeat lookup does not invoke the underlying counter', () => {
    const { counter, calls } = tracking();
    const memoized = memoizeCounter(counter);

    expect(memoized.countText('hello')).toBe(5);
    expect(memoized.countText('hello')).toBe(5);
    expect(memoized.countText('hello')).toBe(5);
    expect(calls).toEqual(['hello']);
  });

  test('distinct strings do not collide', () => {
    const memoized = memoizeCounter({ countText: (text) => text.length, countChat: () => 0 });
    expect(memoized.countText('ab')).toBe(2);
    expect(memoized.countText('abc')).toBe(3);
    expect(memoized.countText('')).toBe(0);
  });

  test('an empty string short-circuits without calling through', () => {
    const { counter, calls } = tracking();
    expect(memoizeCounter(counter).countText('')).toBe(0);
    expect(calls).toEqual([]);
  });

  test('the cache is bounded', () => {
    const { counter, calls } = tracking();
    const memoized = memoizeCounter(counter, 3);

    for (const text of ['a', 'b', 'c', 'd']) memoized.countText(text);
    expect(calls.length).toBe(4);

    // 'a' was evicted when 'd' arrived, so it has to be recomputed.
    memoized.countText('a');
    expect(calls.length).toBe(5);

    // 'd' is still resident.
    memoized.countText('d');
    expect(calls.length).toBe(5);
  });

  test('a hit refreshes recency, so a hot entry is not evicted', () => {
    const { counter, calls } = tracking();
    const memoized = memoizeCounter(counter, 3);

    memoized.countText('a');
    memoized.countText('b');
    memoized.countText('c');
    memoized.countText('a'); // 'a' becomes most recent; 'b' is now the oldest
    memoized.countText('d'); // evicts 'b'

    const before = calls.length;
    memoized.countText('a');
    expect(calls.length).toBe(before);

    memoized.countText('b');
    expect(calls.length).toBe(before + 1);
  });

  test('the memoized counter caches complete message shapes too', () => {
    const memoized = memoizeCounter({
      countText: (text) => text.trim().split(/\s+/).filter(Boolean).length,
      countChat: (messages) => messages.length,
    });
    const messages = [{ role: 'user' as const, content: 'one two three' }];
    expect(memoized.countChat(messages)).toBe(1);
    expect(memoized.countChat(messages)).toBe(1);
  });
});
