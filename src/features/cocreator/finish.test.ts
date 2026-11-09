import { describe, expect, test } from 'bun:test';
import { blankCardData } from '@shared/card/blank.ts';
import type { VersionedCharacter } from '@shared/types/card.ts';
import { FinishAttempt, FinishConflictError, finishPlan } from './finish.ts';
import { seedStash } from './seed.ts';

function record(): VersionedCharacter {
  const data = {
    ...blankCardData('Alice'),
    description: 'Original',
    scenario: 'Garden',
    alternate_greetings: ['One'],
    tags: ['a'],
  };
  return {
    detail: {
      avatar: 'Alice.png',
      name: 'Alice',
      folder: 'Nested',
      description: data.description,
      creator: '',
      tags: data.tags,
      character_version: '',
      hasLorebook: false,
      modified: 1,
      card: { data, unknown: 42 },
    },
    version: 'v1',
    portraitVersion: 'art1',
  };
}
function input() {
  const original = record();
  return {
    mode: 'update' as const,
    stash: seedStash(original.detail, ''),
    baseline: { card: original.detail.card, portraitVersion: original.portraitVersion },
    portraitChanged: false,
  };
}

describe('Finish', () => {
  test('retrying a failed session recording reuses the successful card write', async () => {
    const attempt = new FinishAttempt();
    let writes = 0;
    let records = 0;
    const write = async () => {
      writes++;
      return record();
    };
    const recordResult = async () => {
      records++;
      if (records === 1) throw new Error('session save failed');
    };
    await expect(attempt.run(write, recordResult)).rejects.toThrow('session save failed');
    expect(attempt.result?.detail.avatar).toBe('Alice.png');
    expect(attempt.recorded).toBe(false);
    expect(await attempt.run(write, recordResult)).toBe('Alice.png');
    expect(writes).toBe(1);
    expect(attempt.recorded).toBe(true);
  });
  test('creating a copy retains the complete card and uses the accepted fields', () => {
    const source = input();
    source.stash.description!.text = 'Edited';
    const plan = finishPlan({ ...source, mode: 'create' });
    expect(plan.kind).toBe('create');
    if (plan.kind !== 'create') throw new Error('create');
    expect(plan.card.unknown).toBe(42);
    expect(plan.card.data.description).toBe('Edited');
    expect(plan.card.data.alternate_greetings).toEqual(['One']);
  });
  test('clears and new greetings are saved while unrelated outside changes survive', () => {
    const source = input();
    source.stash.description = undefined;
    source.stash.tags = [];
    const current = record();
    current.detail.card.data.scenario = 'Outside';
    expect(finishPlan(source, current)).toMatchObject({
      kind: 'update',
      patch: { description: '', tags: [] },
      replacePortrait: false,
    });
  });
  test('conflicting fields and portraits require choices tied to the reviewed version', () => {
    const source = input();
    source.stash.description!.text = 'Ours';
    source.portraitChanged = true;
    const current = record();
    current.detail.card.data.description = 'Theirs';
    current.portraitVersion = 'art2';
    expect(() => finishPlan(source, current)).toThrow(FinishConflictError);
    expect(
      finishPlan(
        {
          ...source,
          review: { version: 'v1', choices: { description: 'library', portrait: 'library' } },
        },
        current,
      ),
    ).toMatchObject({ patch: {}, replacePortrait: false });
    current.version = 'v2';
    expect(() =>
      finishPlan(
        {
          ...source,
          review: { version: 'v1', choices: { description: 'draft', portrait: 'draft' } },
        },
        current,
      ),
    ).toThrow(FinishConflictError);
  });
  test('a missing update target never silently creates a card', () => {
    expect(() => finishPlan(input(), null)).toThrow('no longer');
  });
  test('a changed name uses the identity save, not the field patch', () => {
    const source = input();
    source.stash.name!.text = 'Renamed';
    expect(finishPlan(source, record())).toMatchObject({
      kind: 'update',
      name: 'Renamed',
      patch: {},
    });
  });
});
