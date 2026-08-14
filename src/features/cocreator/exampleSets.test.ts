import { describe, expect, test } from 'bun:test';
import { DEFAULT_EXAMPLE_FIELDS } from '@shared/types/cocreator.ts';
import {
  addExampleSet,
  createExampleSet,
  nextSetName,
  removeExampleSet,
  updateExampleSet,
} from './exampleSets.ts';

describe('exampleSets helpers', () => {
  test('nextSetName fills lowest available numeric name', () => {
    expect(nextSetName([])).toBe('Set 1');
    expect(
      nextSetName([
        { id: '1', name: 'Set 1', cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
        { id: '2', name: 'Set 3', cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
      ]),
    ).toBe('Set 2');
  });

  test('createExampleSet creates structured set with cloned cards and fields', () => {
    const fields = { ...DEFAULT_EXAMPLE_FIELDS, scenario: false };
    const cards = ['a.png', 'b.png'];
    const set = createExampleSet('Fantasy Cast', cards, fields, 'custom-id');

    expect(set).toEqual({
      id: 'custom-id',
      name: 'Fantasy Cast',
      cards: ['a.png', 'b.png'],
      fields,
    });
    expect(set.cards).not.toBe(cards);
    expect(set.fields).not.toBe(fields);
  });

  test('addExampleSet appends new set and uses fallback name when empty', () => {
    const sets = addExampleSet([], '', ['char.png'], { ...DEFAULT_EXAMPLE_FIELDS }, 's1');
    expect(sets).toHaveLength(1);
    expect(sets[0]?.name).toBe('Set 1');
    expect(sets[0]?.cards).toEqual(['char.png']);

    const sets2 = addExampleSet(sets, 'Sci-Fi', ['robot.png'], { ...DEFAULT_EXAMPLE_FIELDS }, 's2');
    expect(sets2).toHaveLength(2);
    expect(sets2[1]?.name).toBe('Sci-Fi');
  });

  test('updateExampleSet patches matching set name or fields', () => {
    const initial = [
      { id: 's1', name: 'Original', cards: ['a.png'], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
      { id: 's2', name: 'Other', cards: ['b.png'], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
    ];

    const updated = updateExampleSet(initial, 's1', { name: 'Renamed' });
    expect(updated[0]?.name).toBe('Renamed');
    expect(updated[1]?.name).toBe('Other');
  });

  test('removeExampleSet removes matching set by id', () => {
    const initial = [
      { id: 's1', name: 'Set 1', cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
      { id: 's2', name: 'Set 2', cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
    ];

    const removed = removeExampleSet(initial, 's1');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.id).toBe('s2');
  });
});
