import { expect, test } from 'bun:test';
import { emptyStash } from '@shared/cocreator/stash.ts';
import type { CocreatorSaveSnapshot } from '@shared/types/cocreator.ts';
import { DEFAULT_EXAMPLE_FIELDS } from '@shared/types/cocreator.ts';
import { CocreatorSaveQueue } from './cocreatorPersistence.ts';

test('one session queue retains immutable side context and drains a newer main/side save arriving mid-write', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: CocreatorSaveSnapshot[] = [];
  const queue = new CocreatorSaveQueue(async (snapshot) => {
    writes.push(snapshot);
    if (snapshot.revision === 1) await pending;
  }, 60000);
  const first: CocreatorSaveSnapshot = {
    sessionId: 'session',
    revision: 1,
    title: 'Test',
    stash: emptyStash(),
    examples: { cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
    settings: {},
    finishedAvatar: null,
    messages: [],
    sideChat: {
      snapshot: {
        capturedAt: 1,
        systemPrompt: 'Frozen.',
        exampleBlock: '',
        messages: [{ role: 'user', content: 'Original background.' }],
      },
      settings: {},
      messages: [],
    },
  };
  queue.adopt('session', 0);
  queue.schedule(first);
  const flushing = queue.flush('session');
  first.sideChat!.snapshot.messages[0]!.content = 'Mutated later.';
  queue.schedule({ ...first, revision: 2, title: 'New main edit' });
  release();
  await flushing;
  expect(writes.map((w) => w.revision)).toEqual([1, 2]);
  expect(writes[0]?.sideChat?.snapshot.messages[0]?.content).toBe('Original background.');
  expect(writes[1]?.title).toBe('New main edit');
});
