import { describe, expect, test } from 'bun:test';
import type { CardStash, StashProvenance } from '../types/cocreator.ts';
import {
  clearSlot,
  editGreeting,
  editSlot,
  emptyStash,
  isSlotFilled,
  normalizeStash,
  removeGreeting,
  removeTag,
  reorderGreetings,
  setSlot,
  stashedSlotCount,
  toCardPatch,
} from './stash.ts';

function prov(overrides: Partial<StashProvenance> = {}): StashProvenance {
  return {
    messageId: 'm1',
    swipeIndex: 0,
    at: '2026-08-13T10:00:00.000Z',
    source: 'block',
    ...overrides,
  };
}

function withGreetings(...texts: string[]): CardStash {
  return texts.reduce(
    (stash, text) => setSlot(stash, 'alternate_greeting', text, prov()),
    emptyStash(),
  );
}

describe('filing into slots', () => {
  test('a single slot replaces, keeping the new provenance', () => {
    const first = setSlot(emptyStash(), 'description', 'Old.', prov({ messageId: 'm1' }));
    const second = setSlot(first, 'description', 'New.', prov({ messageId: 'm9', swipeIndex: 2 }));

    expect(second.description).toMatchObject({
      text: 'New.',
      provenance: prov({ messageId: 'm9', swipeIndex: 2 }),
    });
    expect(second.description!.id).toBeTruthy();
  });

  test('alternate greetings append and keep their order — it becomes swipe order', () => {
    const stash = withGreetings('One.', 'Two.', 'Three.');

    expect(stash.alternate_greetings.map((entry) => entry.text)).toEqual([
      'One.',
      'Two.',
      'Three.',
    ]);
  });

  test('a blank greeting is not appended', () => {
    expect(setSlot(emptyStash(), 'alternate_greeting', '   ', prov()).alternate_greetings).toEqual(
      [],
    );
  });

  test('tags split on commas and append', () => {
    const stash = setSlot(emptyStash(), 'tags', 'gothic, keeper , lighthouse', prov());

    expect(stash.tags.map((entry) => entry.text)).toEqual(['gothic', 'keeper', 'lighthouse']);
  });

  test('tags de-duplicate case-insensitively, keeping first-seen order', () => {
    const first = setSlot(emptyStash(), 'tags', 'Gothic, keeper', prov());
    const second = setSlot(first, 'tags', 'GOTHIC, sea, keeper, sea', prov());

    expect(second.tags.map((entry) => entry.text)).toEqual(['Gothic', 'keeper', 'sea']);
  });

  test('a tag batch that adds nothing new is identity', () => {
    const stash = setSlot(emptyStash(), 'tags', 'gothic', prov());

    expect(setSlot(stash, 'tags', 'GOTHIC, , ', prov())).toBe(stash);
  });
});

describe('replacing is destructive, appending is not', () => {
  test('a filled single slot reports itself filled', () => {
    const stash = setSlot(emptyStash(), 'first_mes', 'Cold.', prov());

    expect(isSlotFilled(stash, 'first_mes')).toBe(true);
    expect(isSlotFilled(stash, 'description')).toBe(false);
  });

  test('list slots are never "filled", because appending destroys nothing', () => {
    const stash = withGreetings('One.');

    expect(isSlotFilled(stash, 'alternate_greeting')).toBe(false);
    expect(isSlotFilled(setSlot(stash, 'tags', 'a', prov()), 'tags')).toBe(false);
  });
});

describe('editing in place', () => {
  test('editing a slot marks it edited and leaves provenance intact', () => {
    const stash = setSlot(emptyStash(), 'personality', 'Terse.', prov({ model: 'gpt-5.5' }));
    const next = editSlot(stash, 'personality', 'Terse, but warm.');

    expect(next.personality).toMatchObject({
      text: 'Terse, but warm.',
      provenance: prov({ model: 'gpt-5.5' }),
      edited: true,
    });
    // The id survives an edit: it is the entry's identity, not a hash of its text.
    expect(next.personality!.id).toBe(stash.personality!.id);
  });

  test('editing an empty slot is identity', () => {
    const stash = emptyStash();

    expect(editSlot(stash, 'scenario', 'anything')).toBe(stash);
  });

  test('editing a greeting marks only that one', () => {
    const next = editGreeting(withGreetings('One.', 'Two.'), 1, 'Two, revised.');

    expect(next.alternate_greetings[0]!.edited).toBeUndefined();
    expect(next.alternate_greetings[1]).toMatchObject({ text: 'Two, revised.', edited: true });
  });

  test('reordering is a permutation, not a swap', () => {
    const next = reorderGreetings(withGreetings('A', 'B', 'C', 'D'), 0, 2);

    expect(next.alternate_greetings.map((entry) => entry.text)).toEqual(['B', 'C', 'A', 'D']);
  });

  test('an out-of-range or no-op reorder is identity', () => {
    const stash = withGreetings('A', 'B');

    expect(reorderGreetings(stash, 1, 1)).toBe(stash);
    expect(reorderGreetings(stash, 0, 5)).toBe(stash);
    expect(reorderGreetings(stash, -1, 0)).toBe(stash);
  });

  test('removing leaves the rest in order', () => {
    const next = removeGreeting(withGreetings('A', 'B', 'C'), 1);

    expect(next.alternate_greetings.map((entry) => entry.text)).toEqual(['A', 'C']);

    const tagged = setSlot(emptyStash(), 'tags', 'a, b, c', prov());
    expect(removeTag(tagged, 0).tags.map((entry) => entry.text)).toEqual(['b', 'c']);
  });
});

describe('clearing', () => {
  test('clearing a single slot removes the key entirely', () => {
    const stash = setSlot(emptyStash(), 'scenario', 'A storm.', prov());

    expect(clearSlot(stash, 'scenario')).toEqual(emptyStash());
  });

  test('clearing a list slot empties the whole list', () => {
    expect(clearSlot(withGreetings('A', 'B'), 'alternate_greeting').alternate_greetings).toEqual(
      [],
    );
  });

  test('clearing an already-empty slot is identity, so it costs no revision', () => {
    const stash = emptyStash();

    expect(clearSlot(stash, 'description')).toBe(stash);
    expect(clearSlot(stash, 'alternate_greeting')).toBe(stash);
    expect(clearSlot(stash, 'tags')).toBe(stash);
  });

  test('the badge counts filled slots, with each list counting once', () => {
    let stash = emptyStash();
    expect(stashedSlotCount(stash)).toBe(0);

    stash = setSlot(stash, 'name', 'Elowen', prov());
    stash = setSlot(stash, 'description', 'Tall.', prov());
    stash = setSlot(stash, 'alternate_greeting', 'One.', prov());
    stash = setSlot(stash, 'alternate_greeting', 'Two.', prov());
    stash = setSlot(stash, 'tags', 'gothic, keeper', prov());

    expect(stashedSlotCount(stash)).toBe(4);
  });
});

describe('the card patch', () => {
  test('absent slots are omitted entirely, so nothing gets blanked', () => {
    const patch = toCardPatch(setSlot(emptyStash(), 'description', 'Tall.', prov()));

    expect(patch).toEqual({ description: 'Tall.' });
    expect('personality' in patch).toBe(false);
    expect('alternate_greetings' in patch).toBe(false);
  });

  test('lists become plain string arrays in order', () => {
    let stash = withGreetings('One.', 'Two.');
    stash = setSlot(stash, 'tags', 'gothic, keeper', prov());

    expect(toCardPatch(stash)).toEqual({
      alternate_greetings: ['One.', 'Two.'],
      tags: ['gothic', 'keeper'],
    });
  });

  test('name never travels in the patch — it is the filename identity', () => {
    const patch = toCardPatch(setSlot(emptyStash(), 'name', 'Elowen', prov()));

    expect(patch).toEqual({});
  });

  test('character_book and extensions are never emitted, so the shallow merge is safe', () => {
    let stash = emptyStash();
    for (const slot of [
      'description',
      'personality',
      'scenario',
      'first_mes',
      'mes_example',
      'creator_notes',
      'system_prompt',
      'post_history_instructions',
    ] as const) {
      stash = setSlot(stash, slot, `${slot} text`, prov());
    }
    stash = setSlot(stash, 'alternate_greeting', 'One.', prov());
    stash = setSlot(stash, 'tags', 'a', prov());

    const patch = toCardPatch(stash);
    expect('character_book' in patch).toBe(false);
    expect('extensions' in patch).toBe(false);
    expect(Object.keys(patch).sort()).toEqual([
      'alternate_greetings',
      'creator_notes',
      'description',
      'first_mes',
      'mes_example',
      'personality',
      'post_history_instructions',
      'scenario',
      'system_prompt',
      'tags',
    ]);
  });
});

describe('repairing a stored stash', () => {
  test('null and junk normalise to an empty stash', () => {
    expect(normalizeStash(null)).toEqual(emptyStash());
    expect(normalizeStash('nope')).toEqual(emptyStash());
    expect(normalizeStash(42)).toEqual(emptyStash());
  });

  test('missing and non-array lists become empty arrays', () => {
    expect(normalizeStash({})).toEqual(emptyStash());
    expect(normalizeStash({ alternate_greetings: null, tags: 'gothic' })).toEqual(emptyStash());
  });

  test('an entry with no provenance is repaired rather than dropped', () => {
    const stash = normalizeStash({
      description: { text: 'Tall.' },
      alternate_greetings: [],
      tags: [],
    });

    expect(stash.description).toMatchObject({
      text: 'Tall.',
      provenance: { messageId: '', swipeIndex: 0, at: '', source: 'message' },
    });
    expect(stash.description!.id).toBeTruthy();
  });

  test('entries with no text are dropped from lists', () => {
    const stash = normalizeStash({
      alternate_greetings: [{ text: 'One.' }, { text: '' }, 'nope', null],
      tags: [],
    });

    expect(stash.alternate_greetings.map((entry) => entry.text)).toEqual(['One.']);
  });

  test('a normalised stash round-trips through JSON unchanged', () => {
    let stash = setSlot(emptyStash(), 'description', 'Tall.', prov({ model: 'gpt-5.5' }));
    stash = setSlot(stash, 'alternate_greeting', 'One.', prov({ source: 'selection' }));
    stash = editSlot(stash, 'description', 'Tall and tired.');

    expect(normalizeStash(JSON.parse(JSON.stringify(stash)))).toEqual(stash);
  });
});
