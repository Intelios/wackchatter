import { describe, expect, test } from 'bun:test';
import type { QuickCommand } from '@shared/types/settings.ts';
import {
  addCommand,
  commandHint,
  commandLabel,
  nextCommandName,
  removeCommand,
  updateCommand,
  usableCommands,
} from './quickCommands.ts';

function list(): QuickCommand[] {
  return [
    { id: 'a', name: 'Ending', text: 'Write a definitive ending for this story.' },
    { id: 'b', name: 'Recap', text: 'Summarise the story so far.' },
  ];
}

describe('quick command list edits', () => {
  test('adding appends with a blank body', () => {
    const next = addCommand(list(), 'c');

    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ id: 'c', name: 'Command 1', text: '' });
  });

  test('a rename keeps the id, so nothing detaches from its text', () => {
    const next = updateCommand(list(), 'a', { name: 'Finale' });

    expect(next[0]).toEqual({
      id: 'a',
      name: 'Finale',
      text: 'Write a definitive ending for this story.',
    });
  });

  test('removing by id leaves the rest in order', () => {
    expect(removeCommand(list(), 'a').map((command) => command.id)).toEqual(['b']);
  });

  test('an unknown id changes nothing', () => {
    expect(updateCommand(list(), 'zzz', { name: 'x' })).toEqual(list());
    expect(removeCommand(list(), 'zzz')).toEqual(list());
  });

  test('edits do not mutate the input', () => {
    const original = list();
    const snapshot = structuredClone(original);

    addCommand(original, 'c');
    updateCommand(original, 'a', { text: 'changed' });
    removeCommand(original, 'b');

    expect(original).toEqual(snapshot);
  });
});

describe('nextCommandName', () => {
  test('fills the lowest free slot rather than counting entries', () => {
    // Add three, delete the middle one, add again: counting length would collide with
    // the name already on screen.
    const commands: QuickCommand[] = [
      { id: 'a', name: 'Command 1', text: '' },
      { id: 'c', name: 'Command 3', text: '' },
    ];

    expect(nextCommandName(commands)).toBe('Command 2');
  });

  test('a user-chosen name never blocks a slot', () => {
    const commands: QuickCommand[] = [{ id: 'a', name: 'Ending', text: '' }];
    expect(nextCommandName(commands)).toBe('Command 1');
  });
});

describe('usableCommands', () => {
  test('blank text inserts nothing, so blank commands are excluded', () => {
    const commands: QuickCommand[] = [
      { id: 'a', name: 'Real', text: 'Do the thing.' },
      { id: 'b', name: 'Empty', text: '' },
      { id: 'c', name: 'Whitespace', text: '  \n ' },
    ];
    expect(usableCommands(commands).map((command) => command.id)).toEqual(['a']);
  });
});

describe('commandLabel and commandHint', () => {
  test('the name wins when it has one', () => {
    expect(commandLabel(list()[0]!)).toBe('Ending');
  });

  test('a blank name falls back to a snippet of the text', () => {
    const command: QuickCommand = { id: 'a', name: '   ', text: 'Do the thing.\nMore.' };
    expect(commandLabel(command)).toBe('Do the thing.');
  });

  test('the hint is the first line, truncated', () => {
    const command: QuickCommand = {
      id: 'a',
      name: 'Long',
      text: 'A rather long prompt that goes on and on forever.\nSecond line.',
    };
    const hint = commandHint(command);
    expect(hint).toBe('A rather long prompt that goes o…');
    expect(hint.length).toBe(33);
    expect(hint).not.toContain('Second line.');
  });
});
