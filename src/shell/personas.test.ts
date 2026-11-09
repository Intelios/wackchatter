import { describe, expect, test } from 'bun:test';
import type { Persona } from '@shared/types/chat.ts';
import { depthChoices, depthWords, personaRoster, placementShort } from './personas.ts';

function persona(id: string, name: string, extra: Partial<Persona> = {}): Persona {
  return { id, name, description: '', avatar: null, ...extra };
}

// The server lists personas A–Z.
const LIBRARY = [
  persona('hale', 'Captain Hale'),
  persona('ross', 'Detective Ross', { description: 'Twenty years on the force.' }),
  persona('jack', 'Jack'),
  persona('theo', 'Theo'),
  persona('wren', 'Wren'),
  persona('wren-f', 'Wren', { variantOf: 'wren', variantLabel: 'Fantasy' }),
  persona('wren-s', 'Wren', { variantOf: 'wren', variantLabel: 'Sci-fi' }),
  persona('lost', 'Lost', { variantOf: 'deleted', variantLabel: 'Orphan' }),
];

describe('personaRoster', () => {
  test('your group is the card, with the base first; it is not listed again', () => {
    const roster = personaRoster(LIBRARY, 'wren-s', [], '');
    expect(roster.you?.id).toBe('wren-s');
    expect(roster.tabs.map((p) => p.id)).toEqual(['wren', 'wren-f', 'wren-s']);
    expect(roster.others.map((row) => row.persona.id)).not.toContain('wren');
  });

  test('a group is one row on its base, counting its variants', () => {
    const roster = personaRoster(LIBRARY, 'theo', [], '');
    expect(roster.tabs).toEqual([]);
    const wren = roster.others.find((row) => row.persona.id === 'wren');
    expect(wren?.variants).toBe(2);
    expect(roster.others.map((row) => row.persona.id)).not.toContain('wren-f');
  });

  test('recent first, at group grain, then A–Z; an orphaned variant stands alone', () => {
    const roster = personaRoster(LIBRARY, 'theo', ['wren-f', 'ross', 'gone'], '');
    expect(roster.others.map((row) => row.persona.id)).toEqual([
      'wren',
      'ross',
      'hale',
      'jack',
      'lost',
    ]);
  });

  test('a search lists every match on its own, variants included, but never you', () => {
    const roster = personaRoster(LIBRARY, 'wren', [], 'wren');
    expect(roster.others.map((row) => row.persona.id)).toEqual(['wren-f', 'wren-s']);
    expect(roster.others.every((row) => row.variants === 0)).toBe(true);
    expect(personaRoster(LIBRARY, null, [], 'force').others[0]?.persona.id).toBe('ross');
  });

  test('no persona, or one that was deleted, leaves the card empty', () => {
    expect(personaRoster(LIBRARY, null, [], '').you).toBeNull();
    expect(personaRoster(LIBRARY, 'deleted', [], '').you).toBeNull();
    expect(personaRoster(LIBRARY, 'deleted', [], '').others).toHaveLength(6);
  });
});

describe('placement words', () => {
  test('depth reads as distance from the end', () => {
    expect(depthWords(0)).toBe('after the last message');
    expect(depthWords(1)).toBe('1 message from the end');
    expect(depthWords(4)).toBe('4 messages from the end');
  });

  test('a depth set deeper by hand stays choosable', () => {
    expect(depthChoices(2)).toHaveLength(21);
    expect(depthChoices(40).at(-1)).toEqual({ value: 40, label: '40 messages from the end' });
  });

  test('the short form names the role and depth only for the chat', () => {
    expect(placementShort(persona('a', 'A'))).toBe('In the prompt');
    expect(placementShort(persona('a', 'A', { position: 'atDepth', depth: 3, role: 'user' }))).toBe(
      'user, 3 messages from the end',
    );
  });
});
