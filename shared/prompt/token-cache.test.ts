import { describe, expect, test } from 'bun:test';
import { memoizeCounter } from './token-cache.ts';

/** A counter that records how often it was actually invoked. */
function tracking() {
  const calls: string[] = [];
  const counter = (text: string) => {
    calls.push(text);
    return text.length;
  };
  return { counter, calls };
}

describe('memoizeCounter', () => {
  test('a repeat lookup does not invoke the underlying counter', () => {
    const { counter, calls } = tracking();
    const memoized = memoizeCounter(counter);

    expect(memoized('hello')).toBe(5);
    expect(memoized('hello')).toBe(5);
    expect(memoized('hello')).toBe(5);
    expect(calls).toEqual(['hello']);
  });

  test('distinct strings do not collide', () => {
    const memoized = memoizeCounter((text) => text.length);
    expect(memoized('ab')).toBe(2);
    expect(memoized('abc')).toBe(3);
    expect(memoized('')).toBe(0);
  });

  test('an empty string short-circuits without calling through', () => {
    const { counter, calls } = tracking();
    expect(memoizeCounter(counter)('')).toBe(0);
    expect(calls).toEqual([]);
  });

  test('the cache is bounded', () => {
    const { counter, calls } = tracking();
    const memoized = memoizeCounter(counter, 3);

    for (const text of ['a', 'b', 'c', 'd']) memoized(text);
    expect(calls.length).toBe(4);

    // 'a' was evicted when 'd' arrived, so it has to be recomputed.
    memoized('a');
    expect(calls.length).toBe(5);

    // 'd' is still resident.
    memoized('d');
    expect(calls.length).toBe(5);
  });

  test('a hit refreshes recency, so a hot entry is not evicted', () => {
    const { counter, calls } = tracking();
    const memoized = memoizeCounter(counter, 3);

    memoized('a');
    memoized('b');
    memoized('c');
    memoized('a'); // 'a' becomes most recent; 'b' is now the oldest
    memoized('d'); // evicts 'b'

    const before = calls.length;
    memoized('a');
    expect(calls.length).toBe(before);

    memoized('b');
    expect(calls.length).toBe(before + 1);
  });

  test('the memoized counter is a drop-in for assemblePrompt', () => {
    // assemblePrompt takes (text: string) => number and calls it many times over the
    // same message bodies — the shape this exists to serve.
    const memoized = memoizeCounter((text) => text.trim().split(/\s+/).filter(Boolean).length);
    expect(memoized('one two three')).toBe(3);
    expect(memoized('one two three')).toBe(3);
  });
});
