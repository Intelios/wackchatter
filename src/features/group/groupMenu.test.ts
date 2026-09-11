import { describe, expect, test } from 'bun:test';
import type { GroupMember } from '@shared/types/group.ts';
import { isSeparator, isSubmenu, type MenuAction, type MenuEntry } from '../../components/Menu.tsx';
import { buildGroupMenu, type GroupMenuActions, type GroupMenuState } from './groupMenu.tsx';

const cast: GroupMember[] = [
  { id: 'm1', characterId: 'Mika.png', name: 'Mika', publicProfile: '', muted: false },
  { id: 'm2', characterId: 'Mirei.png', name: 'Mirei', publicProfile: '', muted: false },
  { id: 'm3', characterId: 'Niamh.png', name: 'Niamh', publicProfile: '', muted: true },
];

/** The ordinary case: a configured scene, idle, with a transcript behind it. */
const healthy: GroupMenuState = {
  conversationActive: false,
  generating: false,
  directorConfigured: true,
  messageCount: 4,
  chatId: 'c1',
  members: cast,
  selectedMemberId: 'm1',
  confirmingDelete: false,
};

function spies() {
  const calls: string[] = [];
  const actions: GroupMenuActions = {
    continueConversation: () => calls.push('continueConversation'),
    pauseConversation: () => calls.push('pauseConversation'),
    stopAll: () => calls.push('stopAll'),
    renameScene: () => calls.push('renameScene'),
    openCast: () => calls.push('openCast'),
    openMemory: () => calls.push('openMemory'),
    openInspect: () => calls.push('openInspect'),
    openBranchTree: () => calls.push('openBranchTree'),
    exportScene: () => calls.push('exportScene'),
    selectMember: (id) => calls.push(`selectMember:${id}`),
    deleteScene: () => calls.push('deleteScene'),
    closeScene: () => calls.push('closeScene'),
  };
  return { calls, actions };
}

function build(state: Partial<GroupMenuState> = {}, actions?: GroupMenuActions): MenuEntry[] {
  return buildGroupMenu({ ...healthy, ...state }, actions ?? spies().actions);
}

function item(entries: MenuEntry[], label: string): MenuAction {
  const found = entries.find(
    (entry): entry is MenuAction =>
      !isSeparator(entry) && !isSubmenu(entry) && entry.label === label,
  );
  if (!found) throw new Error(`No menu entry labelled "${label}"`);
  return found;
}

function submenu(entries: MenuEntry[], label: string) {
  const found = entries.find((entry) => isSubmenu(entry) && entry.label === label);
  if (!found || !isSubmenu(found)) throw new Error(`No submenu labelled "${label}"`);
  return found;
}

function actionLabels(entries: MenuEntry[]): string[] {
  return entries.filter((entry): entry is MenuAction => !isSeparator(entry)).map((e) => e.label);
}

/** Entries that only read, so nothing about the scene's state can make them unsafe. */
const ALWAYS_OPEN = ['Cast & settings…', 'Memory…', 'Inspect prompt…', 'Branch timeline…'];

describe('buildGroupMenu', () => {
  test('offers the scene tools on a healthy, idle scene', () => {
    const entries = build();
    expect(actionLabels(entries)).toEqual([
      'Continue conversation',
      'Pause conversation',
      'Stop all',
      ...ALWAYS_OPEN,
      'Rename scene…',
      'Export scene',
      'Customise composer…',
      'Guide next reply',
      'Macro character',
      'Delete scene',
      'Close scene',
    ]);
  });

  test('the first entry starts a scene that has no messages', () => {
    expect(item(build({ messageCount: 0 }), 'Start scene').disabled).toBeFalsy();
  });

  test('an unconfigured director disables only the automatic exchange', () => {
    const entries = build({ directorConfigured: false });
    const entry = item(entries, 'Continue conversation');
    expect(entry.disabled).toBe(true);
    expect(entry.disabledReason).toBe(
      'Choose a director connection and model in Cast & settings first.',
    );
    // Calling on a member by hand is still the way through — the reason is about the
    // exchange, not about the scene.
    for (const label of ALWAYS_OPEN) expect(item(entries, label).disabled).toBeFalsy();
  });

  test('a reply in flight blocks the exchange but not the reads', () => {
    const entries = build({ generating: true });
    for (const label of ['Continue conversation', 'Rename scene…', 'Export scene']) {
      expect(item(entries, label).disabled).toBe(true);
      expect(item(entries, label).disabledReason).toBe('Wait for the current replies to finish.');
    }
    for (const label of ALWAYS_OPEN) expect(item(entries, label).disabled).toBeFalsy();
  });

  test('a running summary and a memory run each name themselves as the blocker', () => {
    expect(item(build({ summaryRunning: true }), 'Continue conversation').disabledReason).toBe(
      'Cancel or finish the current summary first.',
    );
    expect(item(build({ memoryRunning: true }), 'Continue conversation').disabledReason).toBe(
      'Cancel or finish the current memory extraction first.',
    );
  });

  test('pause and stop need something to pause or stop', () => {
    const idle = build();
    expect(item(idle, 'Pause conversation').disabled).toBe(true);
    expect(item(idle, 'Stop all').disabled).toBe(true);
    // A member's reply in flight is stoppable even with the exchange paused.
    const replies = build({ generating: true });
    expect(item(replies, 'Stop all').disabled).toBeFalsy();
  });

  test('a paused conversation with a job in flight can still be stopped', () => {
    // `pause()` clears `running` while its jobs keep streaming, so "is the conversation
    // active" is precisely what must not be the only thing gating Stop.
    const entries = build({ conversationActive: false, generating: true });
    expect(item(entries, 'Pause conversation').disabled).toBe(true);
    expect(item(entries, 'Stop all').disabled).toBeFalsy();
  });

  test('delete is a two-click confirm that disarms on dismissal', () => {
    // The arming itself lives in `GroupChatMenu` (the pure builder only reports the state
    // it is handed), so what is pinned here is the contract that makes the two clicks work:
    // the unarmed entry must keep the menu open, and the armed one must not.
    const unarmed = spies();
    const fresh = item(build({ confirmingDelete: false }, unarmed.actions), 'Delete scene');
    expect(fresh.danger).toBe(true);
    expect(fresh.keepOpen).toBe(true);
    fresh.onSelect();
    expect(unarmed.calls).toEqual(['deleteScene']);

    const armed = spies();
    const confirm = item(build({ confirmingDelete: true }, armed.actions), 'Click again to delete');
    expect(confirm.keepOpen).toBeFalsy();
    confirm.onSelect();
    expect(armed.calls).toEqual(['deleteScene']);
  });

  test('no scene open removes the timeline', () => {
    const entry = item(build({ chatId: null }), 'Branch timeline…');
    expect(entry.disabled).toBe(true);
    expect(entry.disabledReason).toBe('No scene is open.');
  });

  test('the macro-character submenu lists the cast and marks the current pick', () => {
    const { calls, actions } = spies();
    const entries = build({ selectedMemberId: 'm2' }, actions);
    const sub = submenu(entries, 'Macro character');
    expect(sub.entries).toHaveLength(3);
    const rows = sub.entries.filter((entry): entry is MenuAction => !isSeparator(entry));
    expect(rows.map((row) => row.label)).toEqual(['Mika', 'Mirei', 'Niamh']);
    expect(rows.map((row) => row.hint)).toEqual([undefined, 'current', undefined]);

    rows[1]?.onSelect();
    expect(calls).toEqual(['selectMember:m2']);
  });

  test('a duplicated name is disambiguated the way the rest of the app does it', () => {
    const twins: GroupMember[] = [
      { id: 'm1', characterId: 'A.png', name: 'Wren', publicProfile: '', muted: false },
      { id: 'm2', characterId: 'B.png', name: 'Wren', publicProfile: '', muted: false },
    ];
    const rows = submenu(build({ members: twins }), 'Macro character').entries.filter(
      (entry): entry is MenuAction => !isSeparator(entry),
    );
    // Two rows called Wren would be unpickable, so the id rides along — `memberLabel`.
    expect(rows.map((row) => row.label)).toEqual(['Wren [m1]', 'Wren [m2]']);
  });

  test('the submenu hint names the member once, not the whole cast', () => {
    const sub = submenu(build({ selectedMemberId: 'm3' }), 'Macro character');
    expect(sub.hint).toBe('Niamh');
  });
});
