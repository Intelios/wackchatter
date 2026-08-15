import { describe, expect, test } from 'bun:test';
import type { QuickCommand } from '@shared/types/settings.ts';
import type { MenuAction, MenuEntry } from '../../components/Menu.tsx';
import { buildQuickCommandsMenu, type QuickCommandsActions } from './QuickCommands.tsx';
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

const COMMANDS: QuickCommand[] = [
  { id: 'c1', name: 'Ending', text: 'Write a definitive ending.' },
  { id: 'c2', name: 'Recap', text: 'Summarise the story so far.' },
];

function isSeparator(entry: MenuEntry): boolean {
  return 'kind' in entry && entry.kind === 'separator';
}

function menuActions(entries: MenuEntry[]): MenuAction[] {
  return entries.filter((entry): entry is MenuAction => !isSeparator(entry));
}

function spies() {
  const inserted: string[] = [];
  const calls: string[] = [];
  const actions: QuickCommandsActions = {
    insertCommand: (text) => inserted.push(text),
    editQuickCommands: () => calls.push('editQuickCommands'),
  };
  return { inserted, calls, actions };
}

describe('buildQuickCommandsMenu', () => {
  test('with no commands the edit entry alone remains, as the discovery path', () => {
    const { actions } = spies();
    const entries = buildQuickCommandsMenu([], actions);
    expect(entries).toHaveLength(1);
    const [edit] = menuActions(entries);
    expect(edit?.label).toBe('Edit quick commands…');
  });

  test('commands sit ahead of the edit entry, with a separator between', () => {
    const { actions } = spies();
    const entries = buildQuickCommandsMenu(COMMANDS, actions);
    expect(entries).toHaveLength(4); // 2 commands + 1 separator + 1 edit entry
    expect(isSeparator(entries[2]!)).toBe(true);
    expect(menuActions(entries).map((entry) => entry.label)).toEqual([
      'Ending',
      'Recap',
      'Edit quick commands…',
    ]);
  });

  test('selecting a command inserts its text verbatim', () => {
    const { inserted, actions } = spies();
    const [ending, recap] = menuActions(buildQuickCommandsMenu(COMMANDS, actions));

    ending!.onSelect();
    recap!.onSelect();
    expect(inserted).toEqual(['Write a definitive ending.', 'Summarise the story so far.']);
  });

  test('the edit entry opens the editor', () => {
    const { calls, actions } = spies();
    const entries = buildQuickCommandsMenu(COMMANDS, actions);
    menuActions(entries).at(-1)!.onSelect();
    expect(calls).toEqual(['editQuickCommands']);
  });

  test('blank commands stay out of the menu — they would insert nothing', () => {
    const commands: QuickCommand[] = [
      { id: 'a', name: 'Real', text: 'Do the thing.' },
      { id: 'b', name: 'Draft', text: '   ' },
    ];
    const { actions } = spies();
    const labels = menuActions(buildQuickCommandsMenu(commands, actions));
    expect(labels.map((entry) => entry.label)).toEqual(['Real', 'Edit quick commands…']);
  });

  test('an unnamed command borrows its label from the text', () => {
    const commands: QuickCommand[] = [{ id: 'a', name: '', text: 'Do the thing.' }];
    const { actions } = spies();
    const labels = menuActions(buildQuickCommandsMenu(commands, actions));
    expect(labels.map((entry) => entry.label)).toContain('Do the thing.');
  });

  test('duplicate names both survive — entries are keyed by id, not label', () => {
    const commands: QuickCommand[] = [
      { id: 'a', name: 'Ending', text: 'first' },
      { id: 'b', name: 'Ending', text: 'second' },
    ];
    const { inserted, actions } = spies();
    const endings = menuActions(buildQuickCommandsMenu(commands, actions)).filter(
      (entry) => entry.label === 'Ending',
    );

    expect(endings).toHaveLength(2);
    for (const ending of endings) ending.onSelect();
    expect(inserted).toEqual(['first', 'second']);
  });
});
