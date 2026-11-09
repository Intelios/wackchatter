import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VersionedCharacter } from '../../shared/types/card.ts';
import type { CocreatorSession } from '../../shared/types/cocreator.ts';
import { seedStash } from '../../src/features/cocreator/seed.ts';
import {
  createBlankCard,
  createCharacter,
  deleteCharacter,
  getCharacterImage,
  getCharacterRecord,
  updateCharacter,
} from '../lib/characters.ts';
import { resetChatStore } from '../lib/chats.ts';
import { cocreatorStore, resetCocreatorStore } from '../lib/cocreator.ts';
import { closeDatabase } from '../lib/db.ts';
import { DEFAULT_DATA_DIR, ensureDataDirs, setDataDir } from '../lib/paths.ts';
import { cascadeCharacterDelete } from '../lib/references.ts';
import { resetSettingsCache } from '../lib/settings.ts';
import { handleCharacterRoute } from './characters.ts';
import { handleCocreatorRoute } from './cocreator.ts';

let dir: string;
function reset() {
  resetCocreatorStore();
  resetChatStore();
  closeDatabase();
  resetSettingsCache();
}
beforeEach(() => {
  reset();
  dir = mkdtempSync(join(tmpdir(), 'wc-cocreator-route-'));
  setDataDir(dir);
  ensureDataDirs();
});
afterEach(() => {
  reset();
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
});

async function source() {
  const card = createBlankCard('Alice');
  card.unknownTop = { retain: true };
  Object.assign(card.data, {
    description: '  Exact text\n',
    alternate_greetings: ['One', '', 'Two'],
    tags: ['one, two'],
    extensions: { unknown: 7 },
    character_book: { extensions: {}, entries: [] },
  });
  const created = await createCharacter(card, undefined, 'Nested');
  return getCharacterRecord(created.avatar)!;
}
async function start(record: VersionedCharacter) {
  return handleCocreatorRoute(
    new Request('http://localhost/api/cocreator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Edit Alice',
        seedAvatar: record.detail.avatar,
        sourceVersion: record.version,
        stash: seedStash(record.detail, ''),
      }),
    }),
    [],
  );
}

test('the starting fields, full card and inherited artwork are durable before the create response', async () => {
  const original = await source();
  const response = await start(original);
  expect(response?.status).toBe(201);
  const created = (await response!.json()) as CocreatorSession;
  const loaded = cocreatorStore().getSession(created.id)!;
  expect(loaded.stash.description?.text).toBe('  Exact text\n');
  expect(loaded.stash.alternate_greetings.map((e) => e.text)).toEqual(['One', '', 'Two']);
  expect(loaded.stash.tags.map((e) => e.text)).toEqual(['one, two']);
  expect(loaded.baseline?.card.unknownTop).toEqual({ retain: true });
  expect(loaded.messages).toEqual([]);
  const image = await handleCocreatorRoute(
    new Request(`http://localhost/api/cocreator/${created.id}/avatar`),
    [created.id, 'avatar'],
  );
  expect(new Uint8Array(await image!.arrayBuffer())).toEqual(
    new Uint8Array(getCharacterImage(original.detail.avatar)!),
  );
  loaded.stash.description!.text = 'Accepted edit';
  cocreatorStore().replaceSession(created.id, { revision: 1, messages: [], stash: loaded.stash });
  expect(cocreatorStore().getSession(created.id)?.stash.description?.text).toBe('Accepted edit');
});

test('a stale starting-card version creates no partial session', async () => {
  const original = await source();
  await updateCharacter(original.detail.avatar, { description: 'Newer' });
  expect((await start(original))?.status).toBe(409);
  expect(cocreatorStore().listSessions()).toEqual([]);
});

test('source deletion detaches Update but preserves the full draft and portrait for a copy', async () => {
  const original = await source();
  const created = (await (await start(original))!.json()) as CocreatorSession;
  await deleteCharacter(original.detail.avatar, async () =>
    cascadeCharacterDelete(original.detail.avatar),
  );
  const loaded = cocreatorStore().getSession(created.id)!;
  expect(loaded.targetAvatar).toBeNull();
  expect(loaded.baseline?.card.data.extensions.unknown).toBe(7);
  const image = await handleCocreatorRoute(
    new Request(`http://localhost/api/cocreator/${created.id}/avatar`),
    [created.id, 'avatar'],
  );
  expect(image?.status).toBe(200);
});

test('complete-card creation keeps unknown metadata and returns a versioned result', async () => {
  const original = await source();
  const form = new FormData();
  form.set('body', JSON.stringify({ card: original.detail.card, folder: 'Drafts' }));
  form.set(
    'image',
    new File([new Uint8Array(getCharacterImage(original.detail.avatar)!)], 'avatar.png', {
      type: 'image/png',
    }),
  );
  const response = await handleCharacterRoute(
    new Request('http://localhost/api/characters', { method: 'POST', body: form }),
    [],
  );
  const copied = (await response!.json()) as VersionedCharacter;
  expect(copied.detail.avatar).not.toBe(original.detail.avatar);
  expect(copied.detail.folder).toBe('Drafts');
  expect(copied.detail.card.unknownTop).toEqual({ retain: true });
  expect(copied.detail.card.data.extensions.unknown).toBe(7);
  expect(copied.detail.card.data.character_book).toEqual(original.detail.card.data.character_book);
  expect(copied.portraitVersion).toBe(original.portraitVersion);
  expect(copied.version).toBeTruthy();
});
