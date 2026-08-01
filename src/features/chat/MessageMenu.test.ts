import { describe, expect, test } from 'bun:test';
import { type MenuAction, type MenuEntry, isSeparator } from '../../components/Menu.tsx';
import {
  type MessageMenuActions,
  type MessageMenuState,
  buildMessageMenu,
} from './MessageMenu.tsx';

/** The last reply from the character — the ordinary case, everything available. */
const lastReply: MessageMenuState = {
  busy: false,
  isLast: true,
  isUser: false,
  isHidden: false,
  confirmingDelete: false,
};

const noop = () => {};
const actions: MessageMenuActions = {
  regenerate: noop,
  continueLast: noop,
  toggleHidden: noop,
  branch: noop,
  delete: noop,
};

function items(entries: MenuEntry[]): MenuAction[] {
  return entries.filter((entry): entry is MenuAction => !isSeparator(entry));
}

function byLabel(entries: MenuEntry[], startsWith: string): MenuAction | undefined {
  return items(entries).find((entry) => entry.label.startsWith(startsWith));
}

describe('buildMessageMenu', () => {
  test('the last reply offers everything', () => {
    const entries = buildMessageMenu(lastReply, actions);
    for (const entry of items(entries)) {
      expect(entry.disabled).toBeFalsy();
    }
  });

  test('every disabled entry explains itself', () => {
    const entries = buildMessageMenu({ ...lastReply, busy: true }, actions);
    for (const entry of items(entries)) {
      if (entry.disabled) expect(entry.disabledReason).toBeTruthy();
    }
  });

  test('a generation in flight blocks regenerate, continue and branch', () => {
    const entries = buildMessageMenu({ ...lastReply, busy: true }, actions);
    expect(byLabel(entries, 'Regenerate')?.disabled).toBe(true);
    expect(byLabel(entries, 'Continue')?.disabled).toBe(true);
    expect(byLabel(entries, 'Branch')?.disabled).toBe(true);
  });

  test('hide stays available while busy — it does not touch the generation', () => {
    const entries = buildMessageMenu({ ...lastReply, busy: true }, actions);
    expect(byLabel(entries, 'Hide')?.disabled).toBeFalsy();
  });

  test('a message that is not last cannot be regenerated or continued', () => {
    const entries = buildMessageMenu({ ...lastReply, isLast: false }, actions);
    expect(byLabel(entries, 'Regenerate')?.disabled).toBe(true);
    expect(byLabel(entries, 'Continue')?.disabled).toBe(true);
    // Branching from an older message is the whole point of branching.
    expect(byLabel(entries, 'Branch')?.disabled).toBeFalsy();
  });

  /** A user turn at the end is owed a reply; the bubble offers Retry for that instead. */
  test('a trailing user turn cannot be regenerated', () => {
    const entries = buildMessageMenu({ ...lastReply, isUser: true }, actions);
    expect(byLabel(entries, 'Regenerate')?.disabled).toBe(true);
    expect(byLabel(entries, 'Continue')?.disabled).toBe(true);
  });

  test('the hide entry names the direction it will move things', () => {
    expect(byLabel(buildMessageMenu(lastReply, actions), 'Hide')).toBeTruthy();
    const hidden = buildMessageMenu({ ...lastReply, isHidden: true }, actions);
    expect(byLabel(hidden, 'Show')).toBeTruthy();
  });

  test('delete is danger, and arms on the first click rather than firing', () => {
    const entries = buildMessageMenu(lastReply, actions);
    const remove = byLabel(entries, 'Delete');
    expect(remove?.danger).toBe(true);
    // keepOpen is what lets the menu stay up long enough to confirm.
    expect(remove?.keepOpen).toBe(true);
  });

  test('an armed delete closes the menu when confirmed', () => {
    const entries = buildMessageMenu({ ...lastReply, confirmingDelete: true }, actions);
    const remove = byLabel(entries, 'Click again');
    expect(remove).toBeTruthy();
    expect(remove?.keepOpen).toBeFalsy();
  });
});
