import { describe, expect, test } from 'bun:test';
import { createStreamStore } from './streamStore.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('streamStore', () => {
  test('getSnapshot returns a stable object between publishes', () => {
    // A fresh object every call makes useSyncExternalStore re-render forever.
    const store = createStreamStore();
    expect(store.getSnapshot()).toBe(store.getSnapshot());

    store.begin('');
    const during = store.getSnapshot();
    expect(store.getSnapshot()).toBe(during);
  });

  test('begin publishes the seed and marks the stream active', () => {
    const store = createStreamStore();
    store.begin('The door creaked');

    expect(store.getSnapshot().text).toBe('The door creaked');
    expect(store.getSnapshot().active).toBe(true);
  });

  test('a non-streamed generation is marked non-incremental for the whole run', () => {
    // The caret hangs off this flag: nothing arrives until everything does, so there is
    // no progress to blink at.
    const store = createStreamStore(1000);
    store.begin('');
    expect(store.getSnapshot().incremental).toBe(true);

    store.begin('', false);
    expect(store.getSnapshot().incremental).toBe(false);
    store.set('the whole reply at once');
    expect(store.getSnapshot().incremental).toBe(false);
    expect(store.end().incremental).toBe(false);
  });

  test('subscribers are notified and can unsubscribe', () => {
    const store = createStreamStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);

    store.begin('');
    expect(calls).toBe(1);

    unsubscribe();
    store.begin('');
    expect(calls).toBe(1);
  });

  test('rapid writes are throttled rather than published one per token', async () => {
    const store = createStreamStore(30);
    let publishes = 0;
    store.subscribe(() => publishes++);

    store.begin(''); // 1
    for (let i = 0; i < 50; i++) store.set(`token ${i}`);

    // Everything after the first landed inside one 33ms window.
    expect(publishes).toBeLessThan(5);

    await wait(60);
    // The trailing edge fired, so the last value did reach subscribers.
    expect(store.getSnapshot().text).toBe('token 49');
  });

  test('the trailing edge is scheduled, not dropped', async () => {
    // Without this, whatever arrived last before a pause is never shown.
    const store = createStreamStore(30);
    store.begin('');
    store.set('first');
    store.set('second');

    await wait(60);
    expect(store.getSnapshot().text).toBe('second');
  });

  test('end flushes synchronously, so a final token inside the window is not lost', () => {
    const store = createStreamStore(30);
    store.begin('');
    store.set('a');
    // 'b' lands inside the throttle window and is only pending.
    store.set('b');

    const final = store.end();
    expect(final.text).toBe('b');
    expect(final.active).toBe(false);
    // No await: the flush already happened.
    expect(store.getSnapshot().text).toBe('b');
  });

  test('a pending write cannot land after end', async () => {
    const store = createStreamStore(30);
    store.begin('');
    store.set('a');
    store.set('stale');
    store.end();

    await wait(60);
    expect(store.getSnapshot().text).toBe('stale');
    expect(store.getSnapshot().active).toBe(false);
  });

  test('the text is always the full string, never accumulated by the store', () => {
    // The store assigns what it is given; accumulation happens in the SSE layer.
    const store = createStreamStore(1000);
    store.begin('');
    store.set('Hello');
    expect(store.end().text).toBe('Hello');

    store.begin('');
    store.set('Hello, world');
    expect(store.end().text).toBe('Hello, world');
  });

  test('reasoning rides alongside the text', () => {
    const store = createStreamStore(1000);
    store.begin('');
    store.set('answer', 'thinking…');
    const final = store.end();
    expect(final.text).toBe('answer');
    expect(final.reasoning).toBe('thinking…');
  });

  test('a new generation resets the throttle so its first token shows immediately', () => {
    const store = createStreamStore(30);
    store.begin('');
    store.set('a');
    store.end();

    let publishes = 0;
    store.subscribe(() => publishes++);
    store.begin('');
    store.set('fresh');

    expect(publishes).toBe(2);
    expect(store.getSnapshot().text).toBe('fresh');
  });
});
