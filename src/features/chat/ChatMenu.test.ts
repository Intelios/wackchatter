import { describe, expect, test } from 'bun:test';
import type { QuickCommand } from '@shared/types/settings.ts';
import {
  isSeparator,
  isSubmenu,
  type MenuAction,
  type MenuEntry,
  type MenuSubmenu,
} from '../../components/Menu.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { buildChatMenu, type ChatMenuActions, type ChatMenuState } from './ChatMenu.tsx';

/** A transcript ending on the character's turn — the ordinary case, everything available. */
const healthy: ChatMenuState = {
  busy: false,
  messageCount: 4,
  lastMessageId: 'm4',
  lastIsUser: false,
  quickCommands: [],
};

function spies() {
  const calls: string[] = [];
  const panels: RightPanelId[] = [];
  const inserted: string[] = [];
  const actions: ChatMenuActions = {
    newChat: () => calls.push('newChat'),
    checkpoint: (id) => calls.push(`checkpoint:${id}`),
    regenerate: () => calls.push('regenerate'),
    continueLast: () => calls.push('continueLast'),
    openPanel: (tab) => panels.push(tab),
    closeChat: () => calls.push('closeChat'),
    exportChat: () => calls.push('exportChat'),
    insertCommand: (text) => inserted.push(text),
    editQuickCommands: () => calls.push('editQuickCommands'),
  };
  return { calls, panels, inserted, actions };
}

const COMMANDS: QuickCommand[] = [
  { id: 'c1', name: 'Ending', text: 'Write a definitive ending.' },
  { id: 'c2', name: 'Recap', text: 'Summarise the story so far.' },
];

function build(state: Partial<ChatMenuState> = {}, actions?: ChatMenuActions): MenuEntry[] {
  return buildChatMenu({ ...healthy, ...state }, actions ?? spies().actions);
}

function item(entries: MenuEntry[], label: string): MenuAction {
  const found = entries.find(
    (entry): entry is MenuAction =>
      !isSeparator(entry) && !isSubmenu(entry) && entry.label === label,
  );
  if (!found) throw new Error(`No menu entry labelled "${label}"`);
  return found;
}

function submenu(entries: MenuEntry[], label: string): MenuSubmenu {
  const found = entries.find(
    (entry): entry is MenuSubmenu => isSubmenu(entry) && entry.label === label,
  );
  if (!found) throw new Error(`No submenu labelled "${label}"`);
  return found;
}

function actionLabels(entries: MenuEntry[]): string[] {
  return entries
    .filter((entry): entry is MenuAction | MenuSubmenu => !isSeparator(entry))
    .map((e) => e.label);
}

const JUMPS = ['Chat context…', 'Lore…', 'Persona…'];

describe('buildChatMenu', () => {
  test('offers every tool on a healthy transcript', () => {
    const entries = build();
    expect(actionLabels(entries)).toEqual([
      'New chat',
      'Save checkpoint',
      'Regenerate',
      'Continue',
      'Export chat',
      'Quick commands',
      ...JUMPS,
      'Close chat',
    ]);
    for (const label of actionLabels(entries)) {
      if (label === 'Quick commands') expect(submenu(entries, label).disabled).toBeFalsy();
      else expect(item(entries, label).disabled).toBeFalsy();
    }
  });

  test('Continue is unavailable when the transcript ends on the user', () => {
    const entries = build({ lastIsUser: true });
    expect(item(entries, 'Continue').disabled).toBe(true);
    expect(item(entries, 'Continue').disabledReason).toBe('The last message is yours.');
    // Regenerate is still the right move there — it answers the outstanding turn.
    expect(item(entries, 'Regenerate').disabled).toBeFalsy();
  });

  test('an empty chat offers only what does not need a message', () => {
    const entries = build({ messageCount: 0, lastMessageId: null, lastIsUser: false });
    for (const label of ['Save checkpoint', 'Regenerate', 'Continue']) {
      expect(item(entries, label).disabled).toBe(true);
      expect(item(entries, label).disabledReason).toBe('This chat has no messages yet.');
    }
    for (const label of ['New chat', 'Close chat', ...JUMPS]) {
      expect(item(entries, label).disabled).toBeFalsy();
    }
    expect(submenu(entries, 'Quick commands').disabled).toBeFalsy();
  });

  test('a generation in flight disables every action but the jumps and the commands', () => {
    // Commands only fill the composer, and the composer accepts text mid-generation —
    // queueing your next move while a reply streams is the point.
    const entries = build({ busy: true, quickCommands: COMMANDS });
    const open = [...JUMPS, 'Quick commands'];
    for (const label of actionLabels(entries)) {
      if (open.includes(label)) {
        if (label === 'Quick commands') expect(submenu(entries, label).disabled).toBeFalsy();
        else expect(item(entries, label).disabled).toBeFalsy();
      } else {
        const entry = item(entries, label);
        expect(entry.disabled).toBe(true);
        expect(entry.disabledReason).toBe('Wait for the current reply to finish.');
      }
    }
  });

  test('busy outranks empty in the reason, since stopping is what unblocks it', () => {
    const entries = build({ busy: true, messageCount: 0, lastMessageId: null });
    expect(item(entries, 'Regenerate').disabledReason).toBe(
      'Wait for the current reply to finish.',
    );
  });

  test('a blocking summary disables only actions that contact the provider', () => {
    const entries = build({ summaryRunning: true });
    for (const label of ['Regenerate', 'Continue']) {
      expect(item(entries, label).disabled).toBe(true);
      expect(item(entries, label).disabledReason).toBe(
        'Cancel or finish the current summary first.',
      );
    }
    for (const label of ['New chat', 'Save checkpoint', 'Export chat', 'Close chat', ...JUMPS]) {
      expect(item(entries, label).disabled).toBeFalsy();
    }
    expect(submenu(entries, 'Quick commands').disabled).toBeFalsy();
  });

  test('the checkpoint is taken at the last message', () => {
    const { calls, actions } = spies();
    item(build({ lastMessageId: 'm9' }, actions), 'Save checkpoint').onSelect();
    expect(calls).toEqual(['checkpoint:m9']);
  });

  test('selecting an entry calls exactly its own action', () => {
    const { calls, panels, actions } = spies();
    const entries = build({}, actions);

    item(entries, 'New chat').onSelect();
    item(entries, 'Regenerate').onSelect();
    item(entries, 'Continue').onSelect();
    item(entries, 'Export chat').onSelect();
    item(entries, 'Close chat').onSelect();
    expect(calls).toEqual(['newChat', 'regenerate', 'continueLast', 'exportChat', 'closeChat']);

    for (const label of JUMPS) item(entries, label).onSelect();
    expect(panels).toEqual(['characters', 'lorebooks', 'persona']);
  });

  test('Export chat is disabled mid-generation, since the reply is not saved yet', () => {
    const entries = build({ busy: true });
    expect(item(entries, 'Export chat').disabled).toBe(true);
    expect(item(entries, 'Export chat').disabledReason).toBe(
      'Wait for the current reply to finish.',
    );
  });

  test('separators only ever sit between groups', () => {
    for (const state of [{}, { busy: true }, { messageCount: 0, lastMessageId: null }]) {
      const entries = build(state);
      expect(isSeparator(entries[0]!)).toBe(false);
      expect(isSeparator(entries[entries.length - 1]!)).toBe(false);
      for (let i = 1; i < entries.length; i++) {
        expect(isSeparator(entries[i]!) && isSeparator(entries[i - 1]!)).toBe(false);
      }
    }
  });

  test('every disabled entry explains itself', () => {
    for (const state of [
      { busy: true },
      { summaryRunning: true },
      { messageCount: 0, lastMessageId: null },
      { lastIsUser: true },
    ]) {
      for (const entry of build(state)) {
        if (!isSeparator(entry) && entry.disabled) expect(entry.disabledReason).toBeTruthy();
      }
    }
  });
});

describe('buildChatMenu quick commands', () => {
  function flyout(state: Partial<ChatMenuState> = {}, actions?: ChatMenuActions) {
    return submenu(build({ quickCommands: COMMANDS, ...state }, actions), 'Quick commands');
  }

  function flyoutActions(menu: MenuSubmenu): MenuAction[] {
    return menu.entries.filter((entry): entry is MenuAction => !isSeparator(entry));
  }

  test('the burger menu carries one Quick commands entry; the commands live in its flyout', () => {
    const entries = build({ quickCommands: COMMANDS });
    expect(actionLabels(entries)).toContain('Quick commands');
    expect(flyoutActions(flyout()).map((entry) => entry.label)).toEqual([
      'Ending',
      'Recap',
      'Edit quick commands…',
    ]);
  });

  test('the flyout hints at how many commands it holds', () => {
    expect(flyout().hint).toBe('2');
    expect(flyout({ quickCommands: [] }).hint).toBeUndefined();
  });

  test('selecting a command inserts its text verbatim', () => {
    const { inserted, actions } = spies();
    const [ending, recap] = flyoutActions(flyout({}, actions));

    ending!.onSelect();
    recap!.onSelect();
    expect(inserted).toEqual(['Write a definitive ending.', 'Summarise the story so far.']);
  });

  test('the edit entry opens the editor', () => {
    const { calls, actions } = spies();
    flyoutActions(flyout({}, actions)).at(-1)!.onSelect();
    expect(calls).toEqual(['editQuickCommands']);
  });

  test('commands sit ahead of the edit entry, with a separator between', () => {
    const menu = flyout();
    expect(isSeparator(menu.entries[2]!)).toBe(true);
    expect(menu.entries.at(-1)!.kind).toBeUndefined();
  });

  test('blank commands stay out of the flyout — they would insert nothing', () => {
    const commands: QuickCommand[] = [
      { id: 'a', name: 'Real', text: 'Do the thing.' },
      { id: 'b', name: 'Draft', text: '   ' },
    ];
    const labels = flyoutActions(submenu(build({ quickCommands: commands }), 'Quick commands'));
    expect(labels.map((entry) => entry.label)).toEqual(['Real', 'Edit quick commands…']);
  });

  test('an unnamed command borrows its label from the text', () => {
    const commands: QuickCommand[] = [{ id: 'a', name: '', text: 'Do the thing.' }];
    const labels = flyoutActions(submenu(build({ quickCommands: commands }), 'Quick commands'));
    expect(labels.map((entry) => entry.label)).toContain('Do the thing.');
  });

  test('duplicate names both survive — entries are keyed by id, not label', () => {
    const commands: QuickCommand[] = [
      { id: 'a', name: 'Ending', text: 'first' },
      { id: 'b', name: 'Ending', text: 'second' },
    ];
    const { inserted, actions } = spies();
    const endings = flyoutActions(
      submenu(build({ quickCommands: commands }, actions), 'Quick commands'),
    ).filter((entry) => entry.label === 'Ending');

    expect(endings).toHaveLength(2);
    for (const ending of endings) ending.onSelect();
    expect(inserted).toEqual(['first', 'second']);
  });

  test('with no commands the edit entry alone remains, as the discovery path', () => {
    const menu = flyout({ quickCommands: [] });
    expect(menu.entries).toHaveLength(1);
    expect(flyoutActions(menu)[0]!.label).toBe('Edit quick commands…');
  });
});
