import { describe, expect, test } from 'bun:test';
import { appendTake, editTake, hasDirtyTake, stepTake, type Take } from './takes.ts';

function take(name: string): Take {
  return { name, description: `Name: ${name}`, dirty: false };
}

describe('takes', () => {
  test('a re-roll appends a take and selects it', () => {
    const first = appendTake([], take('Iris'));
    expect(first.index).toBe(0);

    const second = appendTake(first.takes, take('Sera'));
    expect(second.index).toBe(1);
    expect(second.takes.map((entry) => entry.name)).toEqual(['Iris', 'Sera']);
  });

  test('stepping back returns the earlier take as it was edited', () => {
    const { takes } = appendTake(appendTake([], take('Iris')).takes, take('Sera'));
    const edited = editTake(takes, 0, { description: 'Name: Iris\n\nAge: 23' });

    const back = stepTake(edited, 1, -1);
    expect(back).toBe(0);
    expect(edited[back]?.description).toBe('Name: Iris\n\nAge: 23');
  });

  test('editing one take does not touch another', () => {
    const { takes } = appendTake(appendTake([], take('Iris')).takes, take('Sera'));
    const edited = editTake(takes, 1, { name: 'Seraphina' });

    expect(edited[0]).toEqual(takes[0] as Take);
    expect(edited[1]?.name).toBe('Seraphina');
  });

  test('an edit marks only its own take dirty', () => {
    const { takes } = appendTake(appendTake([], take('Iris')).takes, take('Sera'));
    expect(hasDirtyTake(takes)).toBe(false);

    const edited = editTake(takes, 1, { name: 'Seraphina' });
    expect(edited[0]?.dirty).toBe(false);
    expect(edited[1]?.dirty).toBe(true);
    expect(hasDirtyTake(edited)).toBe(true);
  });

  test('stepping past either end is a no-op', () => {
    const { takes } = appendTake(appendTake([], take('Iris')).takes, take('Sera'));
    expect(stepTake(takes, 0, -1)).toBe(0);
    expect(stepTake(takes, 1, 1)).toBe(1);
    expect(stepTake([], 0, 1)).toBe(0);
  });

  test('editing an index that does not exist changes nothing', () => {
    const { takes } = appendTake([], take('Iris'));
    expect(editTake(takes, 4, { name: 'Nobody' })).toEqual(takes);
  });
});
