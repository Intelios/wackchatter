import { describe, expect, test } from 'bun:test';
import {
  groupMenuEntries,
  isHeader,
  isSeparator,
  isSubmenu,
  type MenuAction,
  type MenuEntry,
  type MenuHeader,
} from '../../components/Menu.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import {
  buildChatMenu,
  type ChatMenuActions,
  type ChatMenuState,
  toggleGroupKey,
} from './ChatMenu.tsx';
import { nextChatTitle } from './RenameChatPopover.tsx';

/** A transcript ending on the character's turn — the ordinary case, everything available. */
const healthy: ChatMenuState = {
  busy: false,
  memoryMode: 'nexus',
  chatId: 'c1',
  messageCount: 4,
  lastMessageId: 'm4',
  lastIsUser: false,
};

function spies() {
  const calls: string[] = [];
  const panels: RightPanelId[] = [];
  const actions: ChatMenuActions = {
    newChat: () => calls.push('newChat'),
    checkpoint: (id) => calls.push(`checkpoint:${id}`),
    regenerate: () => calls.push('regenerate'),
    continueLast: () => calls.push('continueLast'),
    renameChat: () => calls.push('renameChat'),
    openPanel: (tab) => panels.push(tab),
    closeChat: () => calls.push('closeChat'),
    exportChat: () => calls.push('exportChat'),
    importChat: () => calls.push('importChat'),
    openCard: () => calls.push('openCard'),
    openBranchTree: () => calls.push('openBranchTree'),
    openRecap: () => calls.push('openRecap'),
  };
  return { calls, panels, actions };
}

function build(state: Partial<ChatMenuState> = {}, actions?: ChatMenuActions): MenuEntry[] {
  return buildChatMenu({ ...healthy, ...state }, actions ?? spies().actions);
}

function item(entries: MenuEntry[], label: string): MenuAction {
  const found = entries.find(
    (entry): entry is MenuAction =>
      !isSeparator(entry) && !isHeader(entry) && !isSubmenu(entry) && entry.label === label,
  );
  if (!found) throw new Error(`No menu entry labelled "${label}"`);
  return found;
}

function actionLabels(entries: MenuEntry[]): string[] {
  return entries
    .filter(
      (entry): entry is MenuAction => !isSeparator(entry) && !isHeader(entry) && !isSubmenu(entry),
    )
    .map((entry) => entry.label);
}

function headers(entries: MenuEntry[]): MenuHeader[] {
  return entries.filter(isHeader);
}

/** Entries that open a right panel, in the order their panels are asserted below. */
const JUMPS = ['Chat context…', 'Lore…', 'Persona…'];

/**
 * Everything that stays available whatever the chat is doing.
 *
 * The card and the timeline are in here rather than in JUMPS because they open an overlay
 * rather than a panel, but they share the jumps' one important property: they only ever
 * read, so nothing about a chat's state can make them unsafe.
 */
const ALWAYS_OPEN = ['Character card…', 'Branch timeline…', ...JUMPS];

describe('buildChatMenu', () => {
  test('offers every tool on a healthy transcript', () => {
    const entries = build();
    expect(actionLabels(entries)).toEqual([
      'New chat',
      'Save checkpoint',
      'Rename chat…',
      'Export chat',
      'Import chat',
      'Regenerate',
      'Continue',
      'Impersonate',
      'Guide next reply',
      'Guided swipe',
      'Character card…',
      'Branch timeline…',
      'Previously on…',
      'Customise composer…',
      ...JUMPS,
      'Close chat',
    ]);
    for (const label of actionLabels(entries)) {
      expect(item(entries, label).disabled).toBeFalsy();
    }
  });

  /*
   * The families are what the menu is tinted by, so their identity and order is a real
   * contract, not presentation detail: a run that lost its header would render as an
   * untinted grey block again, which is exactly what this menu was rebuilt to stop being.
   */
  test('entries are laid out as labelled families', () => {
    const { actions } = spies();
    const entries = buildChatMenu(healthy, { ...actions, openNexus: () => {} });
    expect(headers(entries).map((header) => header.label)).toEqual([
      'Memory',
      'Chat',
      'Reply',
      'Inspect',
    ]);
    expect(headers(entries).map((header) => header.hue)).toEqual([1, 3, 4, 2]);
    // Explicit keys, not labels: the collapsed set is persisted by key, so renaming a
    // family's label must not orphan the user's choice.
    expect(headers(entries).map((header) => header.key)).toEqual([
      'memory',
      'chat',
      'reply',
      'inspect',
    ]);
  });

  test('each family owns a contiguous run, and the destructive entry owns none', () => {
    const { actions } = spies();
    const groups = groupMenuEntries(buildChatMenu(healthy, { ...actions, openNexus: () => {} }));

    const chat = groups.find((group) => group.header?.label === 'Chat');
    expect(chat?.entries.map((entry) => entry.label)).toEqual([
      'New chat',
      'Save checkpoint',
      'Rename chat…',
      'Export chat',
      'Import chat',
    ]);

    const reply = groups.find((group) => group.header?.label === 'Reply');
    expect(reply?.entries.map((entry) => entry.label)).toEqual([
      'Regenerate',
      'Continue',
      'Impersonate',
      'Guide next reply',
      'Guided swipe',
    ]);

    // Close chat sits after a separator with no header, so no family tint can reach its red.
    const closeGroup = groups.find((group) =>
      group.entries.some((entry) => entry.label === 'Close chat'),
    );
    expect(closeGroup?.header).toBeUndefined();
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
    for (const label of ['New chat', 'Rename chat…', 'Close chat', ...ALWAYS_OPEN]) {
      expect(item(entries, label).disabled).toBeFalsy();
    }
  });

  test('a generation in flight disables every action but the jumps', () => {
    const entries = build({ busy: true });
    const open = [...ALWAYS_OPEN];
    for (const label of actionLabels(entries)) {
      if (open.includes(label)) {
        expect(item(entries, label).disabled).toBeFalsy();
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
    for (const label of [
      'New chat',
      'Save checkpoint',
      'Rename chat…',
      'Export chat',
      'Close chat',
      ...ALWAYS_OPEN,
    ]) {
      expect(item(entries, label).disabled).toBeFalsy();
    }
  });

  test('a blocking memory extraction disables only actions that contact the provider', () => {
    const entries = build({ memoryRunning: true });
    for (const label of ['Regenerate', 'Continue']) {
      expect(item(entries, label).disabled).toBe(true);
      expect(item(entries, label).disabledReason).toBe(
        'Cancel or finish the current memory extraction first.',
      );
    }
    for (const label of [
      'New chat',
      'Save checkpoint',
      'Rename chat…',
      'Export chat',
      'Close chat',
      ...ALWAYS_OPEN,
    ]) {
      expect(item(entries, label).disabled).toBeFalsy();
    }
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
    item(entries, 'Rename chat…').onSelect();
    item(entries, 'Export chat').onSelect();
    item(entries, 'Import chat').onSelect();
    item(entries, 'Close chat').onSelect();
    expect(calls).toEqual([
      'newChat',
      'regenerate',
      'continueLast',
      'renameChat',
      'exportChat',
      'importChat',
      'closeChat',
    ]);

    for (const label of JUMPS) item(entries, label).onSelect();
    expect(panels).toEqual(['characters', 'lorebooks', 'persona']);

    item(entries, 'Character card…').onSelect();
    expect(calls[calls.length - 1]).toBe('openCard');

    item(entries, 'Branch timeline…').onSelect();
    expect(calls[calls.length - 1]).toBe('openBranchTree');

    item(entries, 'Previously on…').onSelect();
    expect(calls[calls.length - 1]).toBe('openRecap');
  });

  /*
   * The one read-only entry among mutating neighbours, and the reason it is not busy-gated:
   * the composer suppresses `/card` while a reply is streaming, so this is the only way to
   * check a detail in the window where you are most likely to want one.
   */
  test('the card stays open mid-generation, unlike everything around it', () => {
    for (const state of [
      { busy: true },
      { summaryRunning: true },
      { memoryRunning: true },
      { messageCount: 0 },
    ]) {
      expect(item(build(state), 'Character card…').disabled).toBeFalsy();
    }
  });

  test('the branch timeline needs an open chat but nothing else', () => {
    // Even an empty transcript has a timeline — one node and an invitation to branch.
    expect(
      item(build({ messageCount: 0, lastMessageId: null }), 'Branch timeline…').disabled,
    ).toBeFalsy();

    const entry = item(build({ chatId: null }), 'Branch timeline…');
    expect(entry.disabled).toBe(true);
    expect(entry.disabledReason).toBe('No chat is open.');
  });

  /*
   * The recap is a provider generation, so it waits for the current reply; it is not a
   * reader like its neighbours in the family, so `busy` is a real reason to disable it
   * rather than something it can ignore.
   */
  test('Previously on needs a non-empty chat and waits for the current reply', () => {
    expect(item(build(), 'Previously on…').disabled).toBeFalsy();

    const empty = item(build({ messageCount: 0, lastMessageId: null }), 'Previously on…');
    expect(empty.disabled).toBe(true);
    expect(empty.disabledReason).toBe('This chat has no messages yet.');

    const noChat = item(build({ chatId: null }), 'Previously on…');
    expect(noChat.disabled).toBe(true);
    expect(noChat.disabledReason).toBe('No chat is open.');

    const busyEntry = item(build({ busy: true }), 'Previously on…');
    expect(busyEntry.disabled).toBe(true);
    expect(busyEntry.disabledReason).toBe('Wait for the current reply to finish.');

    const summarizing = item(build({ summaryRunning: true }), 'Previously on…');
    expect(summarizing.disabled).toBe(true);
    expect(summarizing.disabledReason).toBe('Cancel or finish the current summary first.');

    const extracting = item(build({ memoryRunning: true }), 'Previously on…');
    expect(extracting.disabled).toBe(true);
    expect(extracting.disabledReason).toBe('Cancel or finish the current memory extraction first.');
  });

  test('Rename chat needs an open chat but not a message', () => {
    // A fresh transcript titled "New chat" is exactly when a real title is wanted most.
    expect(
      item(build({ messageCount: 0, lastMessageId: null }), 'Rename chat…').disabled,
    ).toBeFalsy();

    const entry = item(build({ chatId: null }), 'Rename chat…');
    expect(entry.disabled).toBe(true);
    expect(entry.disabledReason).toBe('No chat is open.');
  });

  test('Export chat is disabled mid-generation, since the reply is not saved yet', () => {
    const entries = build({ busy: true });
    expect(item(entries, 'Export chat').disabled).toBe(true);
    expect(item(entries, 'Export chat').disabledReason).toBe(
      'Wait for the current reply to finish.',
    );
  });

  test('Memory Nexus entry has an icon and triggers openNexus when selected', () => {
    const { calls, actions } = spies();
    const actionsWithNexus: ChatMenuActions = {
      ...actions,
      openNexus: () => calls.push('openNexus'),
    };
    const entries = build({}, actionsWithNexus);
    const nexusEntry = item(entries, 'Memory Nexus');
    expect(nexusEntry.icon).toBeDefined();
    expect(nexusEntry.disabled).toBeFalsy();
    nexusEntry.onSelect();
    expect(calls).toContain('openNexus');

    const disabledEntries = build({ chatId: null }, actionsWithNexus);
    const disabledNexusEntry = item(disabledEntries, 'Memory Nexus');
    expect(disabledNexusEntry.disabled).toBe(true);
    expect(disabledNexusEntry.disabledReason).toBe('No chat is open.');
  });

  /*
   * The Nexus is the memory model in use or it is not: a Summary or Off chat has no explorer
   * behind the entry. The header has to leave with it — a "Memory" eyebrow over nothing is a
   * phantom section, and it would keep the lime family colour alive in a menu whose memory
   * story runs through the Summary panel instead.
   */
  test('the Memory family exists only when the chat runs the Nexus', () => {
    const { actions } = spies();
    const actionsWithNexus: ChatMenuActions = { ...actions, openNexus: () => {} };

    for (const memoryMode of ['classic', 'off'] as const) {
      const entries = build({ memoryMode }, actionsWithNexus);
      expect(actionLabels(entries)).not.toContain('Memory Nexus');
      expect(headers(entries).map((header) => header.label)).not.toContain('Memory');
    }

    // And the first family is exactly the entry under its header when the mode is on.
    const nexusEntries = build({}, actionsWithNexus);
    expect(actionLabels(nexusEntries)).toContain('Memory Nexus');
    expect(headers(nexusEntries)[0]?.label).toBe('Memory');
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
      { memoryRunning: true },
      { messageCount: 0, lastMessageId: null },
      { lastIsUser: true },
    ]) {
      for (const entry of build(state)) {
        if (!isSeparator(entry) && !isHeader(entry) && entry.disabled) {
          expect(entry.disabledReason).toBeTruthy();
        }
      }
    }
  });
});

describe('groupMenuEntries', () => {
  const action = (label: string): MenuAction => ({ label, onSelect: () => {} });
  const header = (label: string, hue?: MenuHeader['hue']): MenuHeader => ({
    kind: 'header',
    label,
    hue,
  });

  test('entries before the first header form an implicit untinted run', () => {
    const groups = groupMenuEntries([action('Loose'), header('Chat'), action('New chat')]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.header).toBeUndefined();
    expect(groups[0]!.entries.map((entry) => entry.label)).toEqual(['Loose']);
    expect(groups[1]!.header?.label).toBe('Chat');
  });

  test('a separator stands alone and starts a fresh run for what follows', () => {
    const groups = groupMenuEntries([
      header('Chat'),
      action('New chat'),
      { kind: 'separator' },
      action('Close chat'),
    ]);
    expect(
      groups.map((group) => (group.separator ? 'sep' : (group.header?.label ?? 'run'))),
    ).toEqual(['Chat', 'sep', 'run']);
    expect(groups[2]!.entries.map((entry) => entry.label)).toEqual(['Close chat']);
  });

  test('an empty list groups to nothing', () => {
    expect(groupMenuEntries([])).toEqual([]);
  });
});

describe('toggleGroupKey', () => {
  test('collapsing adds the key and expanding removes it', () => {
    expect(toggleGroupKey([], 'inspect')).toEqual(['inspect']);
    expect(toggleGroupKey(['inspect'], 'inspect')).toEqual([]);
  });

  test('families collapse independently — one toggle never disturbs another', () => {
    expect(toggleGroupKey(['inspect'], 'reply')).toEqual(['inspect', 'reply']);
    expect(toggleGroupKey(['inspect', 'reply'], 'inspect')).toEqual(['reply']);
  });

  test('collapsing the same key twice is idempotent', () => {
    const once = toggleGroupKey([], 'chat');
    // The set shape makes a double-toggle harmless rather than accumulating duplicates.
    expect(toggleGroupKey(once, 'chat')).toEqual([]);
  });
});

describe('nextChatTitle', () => {
  test('trims the ends and keeps inner spacing, the way /rename parses', () => {
    expect(nextChatTitle('New chat', '  day  two  ')).toBe('day  two');
  });

  test('an empty or unchanged draft is not a rename', () => {
    // Null means no dispatch, so a no-op never bumps the revision or schedules a save.
    expect(nextChatTitle('New chat', '')).toBeNull();
    expect(nextChatTitle('New chat', '   ')).toBeNull();
    expect(nextChatTitle('New chat', 'New chat')).toBeNull();
    // Surrounding whitespace does not make a re-typed title a different one.
    expect(nextChatTitle('New chat', ' New chat ')).toBeNull();
  });
});
