import { describe, expect, test } from 'bun:test';
import { blankCardData } from '../card/blank.ts';
import type { TavernCard } from '../types/card.ts';
import { compareDraft, projectDraft, replaceGreeting } from './draft.ts';
import { emptyStash, setSlot } from './stash.ts';

const provenance = { messageId: 'm', swipeIndex: 0, at: '', source: 'block' as const };
function base(): TavernCard {
  return {
    spec: 'chara_card_v3',
    mystery: { keep: true },
    data: {
      ...blankCardData('Alice'),
      description: 'Original',
      scenario: 'Garden',
      alternate_greetings: ['One', 'Two'],
      tags: ['a, b'],
      extensions: { world: 'Town', unknown: 42 },
      character_book: { extensions: { custom: true }, entries: [] },
    },
  };
}

describe('the working card', () => {
  test('projects explicit empty fields and lists while retaining the complete card', () => {
    const draft = projectDraft(emptyStash(), base());
    expect(draft.data.description).toBe('');
    expect(draft.data.alternate_greetings).toEqual([]);
    expect(draft.data.tags).toEqual([]);
    expect(draft.data.extensions).toEqual(base().data.extensions);
    expect(draft.data.character_book).toEqual(base().data.character_book);
    expect(draft.mystery).toEqual({ keep: true });
  });

  test('preserves unrelated outside edits and writes only our changes, including clears', () => {
    const original = base();
    const draft = structuredClone(original);
    draft.data.description = '';
    const latest = structuredClone(original);
    latest.data.scenario = 'Outside edit';
    const compared = compareDraft(original, latest, draft);
    expect(compared.conflicts).toEqual([]);
    expect(compared.patch).toEqual({ description: '' });
  });

  test('compares conflicting lists as whole fields and accepts identical edits', () => {
    const original = base();
    const draft = structuredClone(original);
    const latest = structuredClone(original);
    draft.data.alternate_greetings.push('Ours');
    latest.data.alternate_greetings.push('Theirs');
    draft.data.description = latest.data.description = 'Same';
    expect(compareDraft(original, latest, draft).conflicts.map((c) => c.field)).toEqual([
      'alternate_greetings',
    ]);
    expect(compareDraft(original, latest, draft).patch).toEqual({});
  });

  test('an unknown legacy baseline requires reviewing differences before updating', () => {
    const draft = base();
    draft.data.scenario = 'Changed';
    expect(compareDraft(null, base(), draft).conflicts.map((c) => c.field)).toEqual(['scenario']);
  });

  test('greeting replacement follows its stable id across a reorder and records its source', () => {
    let stash = setSlot(emptyStash(), 'alternate_greeting', 'One', provenance);
    stash = setSlot(stash, 'alternate_greeting', 'Two', provenance);
    const id = stash.alternate_greetings[0]!.id;
    stash = { ...stash, alternate_greetings: [...stash.alternate_greetings].reverse() };
    const next = replaceGreeting(stash, id, 'Replacement', { ...provenance, conversation: 'side' });
    expect(next.alternate_greetings.map((e) => e.text)).toEqual(['Two', 'Replacement']);
    expect(next.alternate_greetings[1]?.id).toBe(id);
    expect(next.alternate_greetings[1]?.provenance.conversation).toBe('side');
    expect(replaceGreeting(next, 'deleted', 'Lost', provenance)).toBe(next);
  });
});
