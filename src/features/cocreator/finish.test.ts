import { describe, expect, test } from 'bun:test';
import { emptyStash } from '@shared/cocreator/stash.ts';
import type { CharacterDetail } from '@shared/types/card.ts';
import type { CardStash } from '@shared/types/cocreator.ts';
import { finishPlan } from './finish.ts';

const at = { messageId: 'm', swipeIndex: 0, at: '', source: 'block' as const };

function stash(name: string, description: string): CardStash {
  return {
    ...emptyStash(),
    name: { id: 'n', text: name, provenance: at },
    description: { id: 'd', text: description, provenance: at },
  };
}

function seed(name: string): CharacterDetail {
  return {
    avatar: `${name}.png`,
    folder: '',
    name,
    description: '',
    creator: '',
    tags: [],
    character_version: '',
    hasLorebook: false,
    modified: 0,
    card: { spec: 'chara_card_v2', spec_version: '2.0', data: { name } },
  } as unknown as CharacterDetail;
}

describe('Finish', () => {
  test('a new session makes a new card', () => {
    const plan = finishPlan(stash('Hana', 'A barista.'), null);
    expect(plan).toEqual({ kind: 'create', name: 'Hana', patch: { description: 'A barista.' } });
  });

  test('a nameless stash still makes a card', () => {
    expect(finishPlan(stash('  ', 'x'), null)).toMatchObject({ name: 'Untitled Character' });
  });

  test('a session started from a card updates that card', () => {
    expect(finishPlan(stash('Mika', 'Rewritten.'), seed('Mika'))).toEqual({
      kind: 'update',
      avatar: 'Mika.png',
      rename: null,
      patch: { description: 'Rewritten.' },
    });
  });

  test('a new name renames the card it updates', () => {
    expect(finishPlan(stash('Mika Asagiri', 'x'), seed('Mika'))).toMatchObject({
      kind: 'update',
      rename: 'Mika Asagiri',
    });
  });

  test('the name never travels in the patch', () => {
    expect(finishPlan(stash('Hana', 'x'), null).patch).not.toHaveProperty('name');
  });
});
