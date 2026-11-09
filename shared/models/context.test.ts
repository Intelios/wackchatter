import { expect, test } from 'bun:test';
import { contextOrDefault, UNKNOWN_MODEL_CONTEXT } from './context.ts';

test('a model’s own context wins; one that doesn’t say gets a generous size', () => {
  expect(contextOrDefault(1_000_000)).toBe(1_000_000);
  expect(contextOrDefault(200_000.7)).toBe(200_000);
  expect([contextOrDefault(null), contextOrDefault(undefined), contextOrDefault(0)]).toEqual([
    UNKNOWN_MODEL_CONTEXT,
    UNKNOWN_MODEL_CONTEXT,
    UNKNOWN_MODEL_CONTEXT,
  ]);
});
