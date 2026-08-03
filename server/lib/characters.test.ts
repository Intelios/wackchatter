import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBlankCard,
  createCharacter,
  getCharacter,
  listCharacters,
  renameCharacter,
  updateCharacter,
  updateWorldLinks,
} from './characters.ts';
import { DEFAULT_DATA_DIR, PATHS, setDataDir } from './paths.ts';

/* See the note in paths.test.ts: setDataDir is process-wide state and must be put back. */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-characters-'));
  setDataDir(dir);
  mkdirSync(PATHS.characters, { recursive: true });
});

afterEach(() => {
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
});

function create(name: string, folder = '') {
  return createCharacter(createBlankCard(name), undefined, folder);
}

describe('folders', () => {
  test('a card can be created in a folder, and the listing reports where it is', async () => {
    await create('Alice', 'Favourites');
    await create('Bob');

    expect(listCharacters().map((c) => [c.avatar, c.folder])).toEqual([
      ['Alice.png', 'Favourites'],
      ['Bob.png', ''],
    ]);
    expect(existsSync(join(PATHS.characters, 'Favourites/Alice.png'))).toBe(true);
  });

  test('a nested card is readable and writable by its identity alone', async () => {
    const created = await create('Alice', 'Fantasy/Elves');
    expect(created.avatar).toBe('Alice.png');

    expect(getCharacter('Alice.png')?.folder).toBe('Fantasy/Elves');

    const updated = await updateCharacter('Alice.png', { description: 'An elf.' });
    expect(updated?.card.data.description).toBe('An elf.');
    expect(updated?.folder).toBe('Fantasy/Elves');
    expect(getCharacter('Alice.png')?.card.data.description).toBe('An elf.');
  });

  /*
   * The constraint the flat-identity design buys its safety with. Two cards called Alice in
   * different folders would be one character as far as every chat is concerned, so the second
   * one has to take a different name.
   */
  test('names are unique across the whole tree, not per folder', async () => {
    await create('Alice');
    const second = await create('Alice', 'Favourites');

    expect(second.avatar).toBe('Alice1.png');
    expect(existsSync(join(PATHS.characters, 'Favourites/Alice1.png'))).toBe(true);
  });

  test('a rename is not a move: the card stays in its folder', async () => {
    await create('Alice', 'Favourites');

    const renamed = await renameCharacter('Alice.png', 'Alison');
    expect(renamed?.avatar).toBe('Alison.png');
    expect(renamed?.folder).toBe('Favourites');
    expect(existsSync(join(PATHS.characters, 'Favourites/Alison.png'))).toBe(true);
    expect(existsSync(join(PATHS.characters, 'Alison.png'))).toBe(false);
  });

  test('a duplicate basename made outside the app is listed once, not twice', async () => {
    await create('Alice');
    mkdirSync(join(PATHS.characters, 'Copy'), { recursive: true });
    writeFileSync(
      join(PATHS.characters, 'Copy/Alice.png'),
      readFileSync(join(PATHS.characters, 'Alice.png')),
    );

    // Both files resolve to one identity, so showing two rows would mean two views of one card.
    expect(listCharacters().filter((c) => c.avatar === 'Alice.png')).toHaveLength(1);
    expect(listCharacters()[0]?.folder).toBe('');
  });
});

describe('updateWorldLinks', () => {
  /*
   * The regression folders would otherwise introduce. The rewrite used to read the characters
   * directory flat, so once cards could live in subfolders a lorebook rename would silently
   * strand every foldered card still pointing at the old name.
   */
  test('reaches a card inside a folder', async () => {
    await create('Alice', 'Fantasy/Elves');
    await updateCharacter('Alice.png', { extensions: { world: 'OldBook' } });
    expect(getCharacter('Alice.png')?.card.data.extensions.world).toBe('OldBook');

    expect(await updateWorldLinks('OldBook', 'NewBook')).toBe(1);
    expect(getCharacter('Alice.png')?.card.data.extensions.world).toBe('NewBook');
  });

  test('clearing a link reaches a foldered card too', async () => {
    await create('Alice', 'Favourites');
    await updateCharacter('Alice.png', { extensions: { world: 'Doomed' } });

    expect(await updateWorldLinks('Doomed', null)).toBe(1);
    expect(getCharacter('Alice.png')?.card.data.extensions.world).toBeUndefined();
  });
});
