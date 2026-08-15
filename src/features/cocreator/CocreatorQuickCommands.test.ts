import { describe, expect, test } from 'bun:test';
import type { MenuAction, MenuEntry } from '../../components/Menu.tsx';
import type { QuickCommand } from '@shared/types/settings.ts';
import {
  buildCocreatorQuickCommandsMenu,
  type CocreatorQuickCommandsActions,
} from './CocreatorQuickCommands.tsx';

const COMMANDS: QuickCommand[] = [
  { id: '1', name: 'Openings', text: 'Suggest 3 alternate opening messages.' },
  { id: '2', name: 'Personality', text: 'Refine personality traits with more contrast.' },
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
  const actions: CocreatorQuickCommandsActions = {
    insertCommand: (text) => inserted.push(text),
    editQuickCommands: () => calls.push('editQuickCommands'),
  };
  return { inserted, calls, actions };
}

describe('buildCocreatorQuickCommandsMenu', () => {
  test('empty list renders only the edit entry', () => {
    const { actions } = spies();
    const entries = buildCocreatorQuickCommandsMenu([], actions);
    expect(entries).toHaveLength(1);
    const [edit] = menuActions(entries);
    expect(edit?.label).toBe('Edit quick commands…');
  });

  test('commands sit ahead of the edit entry with a separator between', () => {
    const { actions } = spies();
    const entries = buildCocreatorQuickCommandsMenu(COMMANDS, actions);
    expect(entries).toHaveLength(4); // 2 commands + 1 separator + 1 edit entry
    expect(isSeparator(entries[2]!)).toBe(true);
    expect(menuActions(entries).map((entry) => entry.label)).toEqual([
      'Openings',
      'Personality',
      'Edit quick commands…',
    ]);
  });

  test('selecting a command inserts its text', () => {
    const { inserted, actions } = spies();
    const [openings, personality] = menuActions(
      buildCocreatorQuickCommandsMenu(COMMANDS, actions),
    );

    openings!.onSelect();
    personality!.onSelect();
    expect(inserted).toEqual([
      'Suggest 3 alternate opening messages.',
      'Refine personality traits with more contrast.',
    ]);
  });

  test('selecting edit opens the quick commands editor', () => {
    const { calls, actions } = spies();
    const entries = buildCocreatorQuickCommandsMenu(COMMANDS, actions);
    menuActions(entries).at(-1)!.onSelect();
    expect(calls).toEqual(['editQuickCommands']);
  });

  test('blank commands are omitted — they would insert nothing', () => {
    const commands: QuickCommand[] = [
      { id: '1', name: 'Real', text: 'A real instruction.' },
      { id: '2', name: 'Blank', text: '   ' },
    ];
    const { actions } = spies();
    const actionsList = menuActions(buildCocreatorQuickCommandsMenu(commands, actions));
    expect(actionsList.map((entry) => entry.label)).toEqual(['Real', 'Edit quick commands…']);
  });

  test('an unnamed command borrows its label from snippet of text', () => {
    const commands: QuickCommand[] = [
      { id: '1', name: '', text: 'Tell me about the backstory and motivation.' },
    ];
    const { actions } = spies();
    const [cmd] = menuActions(buildCocreatorQuickCommandsMenu(commands, actions));
    expect(cmd?.label).toContain('Tell me about the backstory and');
  });

  test('duplicate names both survive — entries are keyed by id', () => {
    const commands: QuickCommand[] = [
      { id: 'a', name: 'Prompt', text: 'First variation' },
      { id: 'b', name: 'Prompt', text: 'Second variation' },
    ];
    const { inserted, actions } = spies();
    const [first, second] = menuActions(buildCocreatorQuickCommandsMenu(commands, actions));

    first!.onSelect();
    second!.onSelect();
    expect(inserted).toEqual(['First variation', 'Second variation']);
  });
});
