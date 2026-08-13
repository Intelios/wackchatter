import { describe, expect, test } from 'bun:test';
import type { CardSlot } from '@shared/types/cocreator.ts';
import type { MenuAction, MenuEntry } from '../../components/Menu.tsx';
import {
  BUSY_REASON,
  buildUseAsMenu,
  EMPTY_REASON,
  NO_SELECTION_REASON,
  type UseAsMenuActions,
  type UseAsMenuState,
} from './useAsMenu.ts';

function actions(): UseAsMenuActions & { used: CardSlot[]; armed: CardSlot[] } {
  const used: CardSlot[] = [];
  const armed: CardSlot[] = [];
  return {
    used,
    armed,
    onUse: (slot) => used.push(slot),
    onArmConfirm: (slot) => armed.push(slot),
  };
}

function state(overrides: Partial<UseAsMenuState> = {}): UseAsMenuState {
  return {
    slot: 'first_mes',
    text: 'The lamp room is cold.',
    busy: false,
    filled: () => false,
    confirming: null,
    ...overrides,
  };
}

function items(entries: MenuEntry[]): MenuAction[] {
  return entries.filter((entry): entry is MenuAction => entry.kind !== 'separator');
}

function build(overrides: Partial<UseAsMenuState> = {}) {
  const handlers = actions();
  return { entries: buildUseAsMenu(state(overrides), handlers), handlers };
}

describe('what is offered', () => {
  test('every slot is offered, with the block’s own slot first', () => {
    const { entries } = build({ slot: 'description' });
    const keys = items(entries).map((entry) => entry.key);

    expect(keys[0]).toBe('description');
    expect(keys).toHaveLength(11);
    expect(new Set(keys).size).toBe(11);
  });

  test('the block’s own slot is separated from the rest', () => {
    const { entries } = build({ slot: 'first_mes' });

    expect(entries[1]).toEqual({ kind: 'separator' });
  });

  test('an unknown label offers every slot, uncoerced and unseparated', () => {
    const { entries } = build({ slot: null });

    expect(entries.some((entry) => entry.kind === 'separator')).toBe(false);
    expect(items(entries)).toHaveLength(11);
    expect(items(entries)[0]!.key).toBe('name');
  });
});

describe('what is blocked, and why', () => {
  test('every entry is disabled mid-generation and says so', () => {
    const { entries } = build({ busy: true });

    for (const entry of items(entries)) {
      expect(entry.disabled).toBe(true);
      expect(entry.disabledReason).toBe(BUSY_REASON);
    }
  });

  test('blank text disables with its own reason', () => {
    const { entries } = build({ text: '   ' });

    expect(items(entries)[0]!.disabledReason).toBe(EMPTY_REASON);
  });

  test('the selection variant explains an empty selection specifically', () => {
    const { entries } = build({ text: '', requiresSelection: true });

    expect(items(entries)[0]!.disabledReason).toBe(NO_SELECTION_REASON);
  });

  test('generating beats blank when both apply', () => {
    const { entries } = build({ text: '', busy: true, requiresSelection: true });

    expect(items(entries)[0]!.disabledReason).toBe(BUSY_REASON);
  });

  test('nothing is disabled in the ordinary case', () => {
    const { entries } = build();

    for (const entry of items(entries)) {
      expect(entry.disabled).toBe(false);
      expect(entry.disabledReason).toBeUndefined();
    }
  });
});

describe('replacing takes two clicks', () => {
  const filled = (slot: CardSlot) => slot === 'first_mes';

  test('an empty slot fires immediately', () => {
    const handlers = actions();
    const entries = buildUseAsMenu(state({ filled }), handlers);
    const description = items(entries).find((entry) => entry.key === 'description')!;

    description.onSelect();
    expect(handlers.used).toEqual(['description']);
    expect(handlers.armed).toEqual([]);
    expect(description.keepOpen).toBe(false);
  });

  test('a filled slot arms instead of firing, and keeps the menu open', () => {
    const handlers = actions();
    const entries = buildUseAsMenu(state({ filled }), handlers);
    const firstMes = items(entries).find((entry) => entry.key === 'first_mes')!;

    expect(firstMes.hint).toBe('replaces');
    expect(firstMes.keepOpen).toBe(true);

    firstMes.onSelect();
    expect(handlers.armed).toEqual(['first_mes']);
    expect(handlers.used).toEqual([]);
  });

  test('the second click on an armed slot files it', () => {
    const handlers = actions();
    const entries = buildUseAsMenu(state({ filled, confirming: 'first_mes' }), handlers);
    const firstMes = items(entries).find((entry) => entry.key === 'first_mes')!;

    expect(firstMes.danger).toBe(true);
    expect(firstMes.description).toBe('Click again to replace what is filed');
    expect(firstMes.keepOpen).toBe(false);

    firstMes.onSelect();
    expect(handlers.used).toEqual(['first_mes']);
  });

  test('list slots never arm, because appending destroys nothing', () => {
    const handlers = actions();
    // `isSlotFilled` reports false for list slots, which is what this relies on.
    const entries = buildUseAsMenu(state({ filled: () => false }), handlers);
    const greeting = items(entries).find((entry) => entry.key === 'alternate_greeting')!;

    expect(greeting.hint).toBeUndefined();
    expect(greeting.keepOpen).toBe(false);
    greeting.onSelect();
    expect(handlers.used).toEqual(['alternate_greeting']);
  });
});
