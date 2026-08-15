import { beforeEach, describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '@shared/types/card.ts';
import {
  type CardSnapshot,
  createCardStore,
  forgetAllSections,
  recallSection,
  rememberSection,
} from './cardStore.ts';

const CARD = { name: 'Mirei', description: 'Tall.' } as unknown as CardDataV2;
const OTHER = { name: 'Niamh', description: 'Ginger.' } as unknown as CardDataV2;
const render = (text: string) => text;

function snapshot(overrides: Partial<CardSnapshot> = {}): CardSnapshot {
  return { avatar: 'Mirei.png', card: CARD, render, ...overrides };
}

describe('the card store', () => {
  test('starts idle rather than undefined', () => {
    expect(createCardStore().getSnapshot()).toEqual({
      avatar: null,
      card: null,
      render: expect.any(Function),
    });
  });

  test('a change is published to every subscriber', () => {
    const store = createCardStore();
    let notified = 0;
    store.subscribe(() => notified++);

    store.set(snapshot());

    expect(notified).toBe(1);
    expect(store.getSnapshot().card).toBe(CARD);
  });

  /*
   * The whole point. The caller syncs from an effect, so `set` is handed a fresh object
   * literal on every render of the view — including the dozens a second a generation
   * causes. Publishing those would defeat the store.
   */
  test('an identical snapshot is not published, even as a new object', () => {
    const store = createCardStore();
    store.set(snapshot());

    let notified = 0;
    store.subscribe(() => notified++);
    store.set(snapshot());
    store.set(snapshot());

    expect(notified).toBe(0);
  });

  test('each field on its own counts as a change', () => {
    for (const change of [{ avatar: 'Niamh.png' }, { card: OTHER }, { render: (t: string) => t }]) {
      const store = createCardStore();
      store.set(snapshot());
      let notified = 0;
      store.subscribe(() => notified++);

      store.set(snapshot(change));

      expect(notified).toBe(1);
    }
  });

  /* React tears if getSnapshot returns a new object each call. */
  test('getSnapshot is referentially stable between sets', () => {
    const store = createCardStore();
    store.set(snapshot());

    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  test('unsubscribing stops the notifications', () => {
    const store = createCardStore();
    let notified = 0;
    const stop = store.subscribe(() => notified++);

    stop();
    store.set(snapshot());

    expect(notified).toBe(0);
  });

  test('closing the character clears the card', () => {
    const store = createCardStore();
    store.set(snapshot());
    store.set({ avatar: null, card: null, render });

    expect(store.getSnapshot().card).toBeNull();
  });
});

describe('remembering the open section', () => {
  beforeEach(forgetAllSections);

  test('a card reopens where it was left', () => {
    rememberSection('Mirei.png', 'description:appearance');

    expect(recallSection('Mirei.png')).toBe('description:appearance');
  });

  /* Two characters open in one session must not inherit each other's place. */
  test('memory does not leak between cards', () => {
    rememberSection('Mirei.png', 'description:appearance');

    expect(recallSection('Niamh.png')).toBeNull();
  });

  test('the latest position wins', () => {
    rememberSection('Mirei.png', 'field:description');
    rememberSection('Mirei.png', 'field:scenario');

    expect(recallSection('Mirei.png')).toBe('field:scenario');
  });

  test('no character open means nothing to recall', () => {
    expect(recallSection(null)).toBeNull();
    expect(recallSection('')).toBeNull();
  });
});
