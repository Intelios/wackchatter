import { describe, expect, test } from 'bun:test';
import type { PersistentGuide } from '@shared/types/chat.ts';
import { addGuide, countEnabledGuides, nextGuideName, removeGuide, updateGuide } from './guides.ts';

function list(): PersistentGuide[] {
  return [
    { id: 'a', name: 'Tone', text: 'Be rude.', enabled: true },
    { id: 'b', name: 'Pace', text: 'Go slowly.', enabled: false },
  ];
}

describe('guide list edits', () => {
  test('adding appends with a blank body, enabled', () => {
    const next = addGuide(list(), 'c');

    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ id: 'c', name: 'Guide 1', text: '', enabled: true });
  });

  test('a rename keeps the id, so nothing detaches from its text', () => {
    const next = updateGuide(list(), 'a', { name: 'Voice' });

    expect(next[0]).toEqual({ id: 'a', name: 'Voice', text: 'Be rude.', enabled: true });
  });

  test('toggling off keeps the text, so it can come back', () => {
    const next = updateGuide(list(), 'a', { enabled: false });

    expect(next[0]!.enabled).toBe(false);
    expect(next[0]!.text).toBe('Be rude.');
  });

  test('removing by id leaves the rest in order', () => {
    expect(removeGuide(list(), 'a').map((guide) => guide.id)).toEqual(['b']);
  });

  test('an unknown id changes nothing', () => {
    expect(updateGuide(list(), 'zzz', { name: 'x' })).toEqual(list());
    expect(removeGuide(list(), 'zzz')).toEqual(list());
  });

  test('edits do not mutate the input, which the reducer compares by identity', () => {
    const original = list();
    const snapshot = structuredClone(original);

    addGuide(original, 'c');
    updateGuide(original, 'a', { text: 'changed' });
    removeGuide(original, 'b');

    expect(original).toEqual(snapshot);
  });
});

describe('nextGuideName', () => {
  test('fills the lowest free slot rather than counting entries', () => {
    // Add three, delete the middle one, add again: counting length would collide with
    // the name already on screen.
    const guides: PersistentGuide[] = [
      { id: 'a', name: 'Guide 1', text: '', enabled: true },
      { id: 'c', name: 'Guide 3', text: '', enabled: true },
    ];

    expect(nextGuideName(guides)).toBe('Guide 2');
  });

  test('a user-chosen name never blocks a slot', () => {
    const guides: PersistentGuide[] = [{ id: 'a', name: 'Tone', text: '', enabled: true }];
    expect(nextGuideName(guides)).toBe('Guide 1');
  });
});

describe('countEnabledGuides', () => {
  test('counts only guides that will actually reach the prompt', () => {
    expect(countEnabledGuides(list())).toBe(1);
  });

  test('an enabled but empty guide is not counted, because it injects nothing', () => {
    // The badge is the only signal that something invisible is shaping every reply, so it
    // has to agree with what assembly does — which skips blank content.
    const guides: PersistentGuide[] = [{ id: 'a', name: 'Empty', text: '  ', enabled: true }];
    expect(countEnabledGuides(guides)).toBe(0);
  });
});
