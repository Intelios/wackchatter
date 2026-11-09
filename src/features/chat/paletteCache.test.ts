import { expect, test } from 'bun:test';
import { createPaletteCache } from './paletteCache.ts';

test('a versioned image is extracted once and its completed palette is immediately readable', async () => {
  const calls: string[] = [];
  const cache = createPaletteCache(async (url) => {
    calls.push(url);
    return { colors: ['#123456'], candidates: ['#123456'] };
  });
  const a = cache.get('portrait?v=1');
  expect(cache.get('portrait?v=1')).toBe(a);
  expect(cache.peek('portrait?v=1')).toBeUndefined();
  expect(await a).toEqual(cache.peek('portrait?v=1') ?? null);
  await cache.get('portrait?v=2');
  expect(calls).toEqual(['portrait?v=1', 'portrait?v=2']);
});

test('evicted pending work cannot overwrite a newer entry and failed images stay bounded', async () => {
  const finish: Array<(value: null) => void> = [];
  const cache = createPaletteCache(() => new Promise((resolve) => finish.push(resolve)), 1);
  const old = cache.get('a');
  const other = cache.get('b');
  const fresh = cache.get('a');
  finish[0]!(null);
  await old;
  expect(cache.peek('a')).toBeUndefined();
  finish[1]!(null);
  await other;
  expect(cache.peek('b')).toBeUndefined();
  finish[2]!(null);
  await fresh;
  expect(cache.peek('a')).toBeNull();
  const failed = createPaletteCache(async () => {
    throw new Error('broken image');
  });
  expect(await failed.get('bad')).toBeNull();
  expect(failed.peek('bad')).toBeNull();
});
