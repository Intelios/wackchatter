import { describe, expect, test } from 'bun:test';
import { filterChoices, typeaheadIndex } from './selectLogic.ts';

describe('filterChoices', () => {
  const choices = [
    { value: 1, label: 'Seraphina', description: 'Forest guardian' },
    { value: 2, label: 'Lena', description: 'Sniper, Strix unit' },
    { value: 3, label: 'Mika' },
  ];

  test('an empty query keeps everything', () => {
    expect(filterChoices(choices, '  ')).toHaveLength(3);
  });

  test('matches the label or the description, ignoring case', () => {
    expect(filterChoices(choices, 'SERA').map((choice) => choice.value)).toEqual([1]);
    expect(filterChoices(choices, 'strix').map((choice) => choice.value)).toEqual([2]);
    expect(filterChoices(choices, 'nobody')).toEqual([]);
  });
});

describe('typeaheadIndex', () => {
  const labels = ['Alpha', 'Apex', 'Beta', 'Bravo', 'Charlie'];

  test('a letter steps to the next match after the current option', () => {
    expect(typeaheadIndex(labels, 'b', 0)).toBe(2);
    expect(typeaheadIndex(labels, 'b', 2)).toBe(3);
  });

  test('repeating one letter cycles through its matches and wraps', () => {
    expect(typeaheadIndex(labels, 'aa', 0)).toBe(1);
    expect(typeaheadIndex(labels, 'aaa', 1)).toBe(0);
  });

  test('a longer prefix narrows, and may keep the option already focused', () => {
    expect(typeaheadIndex(labels, 'br', 0)).toBe(3);
    expect(typeaheadIndex(labels, 'ap', 1)).toBe(1);
  });

  test('ignores case, and reports no match as -1', () => {
    expect(typeaheadIndex(labels, 'CH', -1)).toBe(4);
    expect(typeaheadIndex(labels, 'z', 0)).toBe(-1);
    expect(typeaheadIndex([], 'a', 0)).toBe(-1);
  });
});
