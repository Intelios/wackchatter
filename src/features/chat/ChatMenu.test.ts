import { describe, expect, test } from 'bun:test';
import { isSeparator, type MenuAction, type MenuEntry } from '../../components/Menu.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { buildChatMenu, type ChatMenuActions, type ChatMenuState } from './ChatMenu.tsx';

/** A transcript ending on the character's turn — the ordinary case, everything available. */
const healthy: ChatMenuState = {
  busy: false,
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
    openPanel: (tab) => panels.push(tab),
    closeChat: () => calls.push('closeChat'),
    exportChat: () => calls.push('exportChat'),
    importChat: () => calls.push('importChat'),
    openCard: () => calls.push('openCard'),
  };
  return { calls, panels, actions };
}

function build(state: Partial<ChatMenuState> = {}, actions?: ChatMenuActions): MenuEntry[] {
  return buildChatMenu({ ...healthy, ...state }, actions ?? spies().actions);
}

function item(entries: MenuEntry[], label: string): MenuAction {
  const found = entries.find(
    (entry): entry is MenuAction =>
      !isSeparator(entry) && entry.kind !== 'submenu' && entry.label === label,
  );
  if (!found) throw new Error(`No menu entry labelled "${label}"`);
  return found;
}

function actionLabels(entries: MenuEntry[]): string[] {
  return entries.filter((entry): entry is MenuAction => !isSeparator(entry)).map((e) => e.label);
}

/** Entries that open a right panel, in the order their panels are asserted below. */
const JUMPS = ['Chat context…', 'Lore…', 'Persona…'];

/**
 * Everything that stays available whatever the chat is doing.
 *
 * The card is in here rather than in JUMPS because it opens an overlay rather than a panel,
 * but it shares their one important property: it only ever reads, so nothing about a chat's
 * state can make it unsafe.
 */
const ALWAYS_OPEN = ['Character card…', ...JUMPS];

describe('buildChatMenu', () => {
  test('offers every tool on a healthy transcript', () => {
    const entries = build();
    expect(actionLabels(entries)).toEqual([
      'New chat',
      'Save checkpoint',
      'Regenerate',
      'Continue',
      'Export chat',
      'Import chat',
      ...ALWAYS_OPEN,
      'Close chat',
    ]);
    for (const label of actionLabels(entries)) {
      expect(item(entries, label).disabled).toBeFalsy();
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
    for (const label of ['New chat', 'Close chat', ...ALWAYS_OPEN]) {
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
    item(entries, 'Export chat').onSelect();
    item(entries, 'Import chat').onSelect();
    item(entries, 'Close chat').onSelect();
    expect(calls).toEqual([
      'newChat',
      'regenerate',
      'continueLast',
      'exportChat',
      'importChat',
      'closeChat',
    ]);

    for (const label of JUMPS) item(entries, label).onSelect();
    expect(panels).toEqual(['characters', 'lorebooks', 'persona']);

    item(entries, 'Character card…').onSelect();
    expect(calls[calls.length - 1]).toBe('openCard');
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
      { memoryRunning: true },
      { messageCount: 0, lastMessageId: null },
      { lastIsUser: true },
    ]) {
      for (const entry of build(state)) {
        if (!isSeparator(entry) && entry.disabled) expect(entry.disabledReason).toBeTruthy();
      }
    }
  });
});
