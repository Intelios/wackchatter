import { describe, expect, test } from 'bun:test';
import type { CardUpdate } from '../types/card.ts';
import { cleanUpdates } from './updates.ts';

describe('cleanUpdates', () => {
  test('drops entries whose text says nothing', () => {
    const kept: CardUpdate = { label: 'v1.2', text: 'Rebalanced the lorebook.' };
    expect(cleanUpdates([kept, { label: 'v1.1', text: '   ' }, { text: '' }])).toEqual([kept]);
  });

  test('keeps entries without labels, in order', () => {
    const a: CardUpdate = { text: 'first' };
    const b: CardUpdate = { label: 'v2', text: 'second' };
    expect(cleanUpdates([a, b])).toEqual([a, b]);
  });

  test('undefined is an empty list', () => {
    expect(cleanUpdates(undefined)).toEqual([]);
  });
});
