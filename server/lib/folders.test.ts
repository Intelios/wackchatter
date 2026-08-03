import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFolder,
  deleteFolder,
  folderOf,
  listFolders,
  moveCharacterToFolder,
  renameFolder,
  resolveCharacterFile,
  walkCharacterFiles,
} from './folders.ts';
import { DEFAULT_DATA_DIR, PATHS, setDataDir } from './paths.ts';

/* See the note in paths.test.ts: setDataDir is process-wide state and must be put back. */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-folders-'));
  setDataDir(dir);
  mkdirSync(PATHS.characters, { recursive: true });
});

afterEach(() => {
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
});

/** The tests here only care about paths, so a card can be any bytes. */
function card(...segments: string[]): void {
  const path = join(PATHS.characters, ...segments);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'png');
}

describe('walkCharacterFiles', () => {
  test('finds cards at every depth and reports the folder separately from the identity', () => {
    card('Root.png');
    card('Fantasy', 'Elf.png');
    card('Fantasy', 'Elves', 'Deep.png');

    expect(walkCharacterFiles()).toEqual([
      { avatar: 'Root.png', folder: '', path: join(PATHS.characters, 'Root.png') },
      { avatar: 'Elf.png', folder: 'Fantasy', path: join(PATHS.characters, 'Fantasy/Elf.png') },
      {
        avatar: 'Deep.png',
        folder: 'Fantasy/Elves',
        path: join(PATHS.characters, 'Fantasy/Elves/Deep.png'),
      },
    ]);
  });

  test('ignores non-PNG files, hidden entries and hidden folders', () => {
    card('Real.png');
    writeFileSync(join(PATHS.characters, 'notes.txt'), 'x');
    writeFileSync(join(PATHS.characters, '.DS_Store'), 'x');
    card('.Trash', 'Deleted.png');

    expect(walkCharacterFiles().map((f) => f.avatar)).toEqual(['Real.png']);
  });

  test('the delete tombstone is not a card', () => {
    card('Real.png');
    writeFileSync(join(PATHS.characters, 'Gone.png.abc123.deleting'), 'x');

    expect(walkCharacterFiles().map((f) => f.avatar)).toEqual(['Real.png']);
  });
});

describe('listFolders', () => {
  test('includes empty folders, so a folder needs no record beyond the directory', () => {
    mkdirSync(join(PATHS.characters, 'Empty'), { recursive: true });
    card('Fantasy', 'Elves', 'Deep.png');

    expect(listFolders()).toEqual(['Empty', 'Fantasy', 'Fantasy/Elves']);
  });

  test('skips hidden folders', () => {
    mkdirSync(join(PATHS.characters, '.Spotlight-V100'), { recursive: true });
    mkdirSync(join(PATHS.characters, 'Real'), { recursive: true });

    expect(listFolders()).toEqual(['Real']);
  });
});

describe('resolveCharacterFile', () => {
  test('finds a card wherever it sits', () => {
    card('Fantasy', 'Elves', 'Deep.png');
    expect(resolveCharacterFile('Deep.png')).toBe(join(PATHS.characters, 'Fantasy/Elves/Deep.png'));
  });

  test('returns null for a card that is not there', () => {
    expect(resolveCharacterFile('Nobody.png')).toBeNull();
  });

  /*
   * Duplicates cannot be made through the app — uniqueName sees the whole tree — but a file
   * browser can make one. The same identity must not resolve to a different file between two
   * calls, so the shallowest path wins and ties break alphabetically.
   */
  test('resolves a duplicate basename deterministically, shallowest first', () => {
    card('B', 'Same.png');
    card('A', 'Same.png');
    card('A', 'Nested', 'Same.png');

    expect(resolveCharacterFile('Same.png')).toBe(join(PATHS.characters, 'A/Same.png'));
    expect(folderOf(resolveCharacterFile('Same.png')!)).toBe('A');
  });

  test('a traversal attempt cannot resolve to a file outside the library', () => {
    writeFileSync(join(dir, 'secret.png'), 'x');
    expect(resolveCharacterFile('../secret.png')).toBeNull();
    expect(resolveCharacterFile('..')).toBeNull();
  });
});

describe('createFolder', () => {
  test('creates nested folders and returns the normalised path', () => {
    expect(createFolder('Fantasy/Elves')).toBe('Fantasy/Elves');
    expect(existsSync(join(PATHS.characters, 'Fantasy/Elves'))).toBe(true);
  });

  test('refuses to create the root or an unusable path', () => {
    expect(createFolder('')).toBeNull();
    expect(createFolder('..')).toBeNull();
  });

  test('a traversal attempt lands inside the characters directory', () => {
    expect(createFolder('../../escaped')).toBe('escaped');
    expect(existsSync(join(PATHS.characters, 'escaped'))).toBe(true);
    expect(existsSync(join(dir, '..', 'escaped'))).toBe(false);
  });
});

describe('moveCharacterToFolder', () => {
  /* The point of the whole design: a move changes where the file is and nothing else. */
  test('moves the file and leaves the identity alone', async () => {
    card('Alice.png');

    expect(await moveCharacterToFolder('Alice.png', 'Favourites')).toBe('Favourites');
    expect(existsSync(join(PATHS.characters, 'Favourites/Alice.png'))).toBe(true);
    expect(existsSync(join(PATHS.characters, 'Alice.png'))).toBe(false);
    expect(walkCharacterFiles()[0]?.avatar).toBe('Alice.png');
  });

  test('moves back to the top level with an empty folder', async () => {
    card('Fantasy', 'Alice.png');

    expect(await moveCharacterToFolder('Alice.png', '')).toBe('');
    expect(existsSync(join(PATHS.characters, 'Alice.png'))).toBe(true);
  });

  test('creates the destination folder on demand', async () => {
    card('Alice.png');
    await moveCharacterToFolder('Alice.png', 'New/Nested');
    expect(existsSync(join(PATHS.characters, 'New/Nested/Alice.png'))).toBe(true);
  });

  test('is a no-op when the card is already there', async () => {
    card('Fantasy', 'Alice.png');
    expect(await moveCharacterToFolder('Alice.png', 'Fantasy')).toBe('Fantasy');
    expect(existsSync(join(PATHS.characters, 'Fantasy/Alice.png'))).toBe(true);
  });

  test('refuses rather than overwriting a card already at the destination', async () => {
    card('A', 'Same.png');
    card('B', 'Same.png');

    // Resolution picks A/Same.png; moving it onto B/Same.png must not destroy either.
    await expect(moveCharacterToFolder('Same.png', 'B')).rejects.toThrow('already exists');
    expect(existsSync(join(PATHS.characters, 'A/Same.png'))).toBe(true);
    expect(existsSync(join(PATHS.characters, 'B/Same.png'))).toBe(true);
  });

  test('returns null for a card that is not there', async () => {
    expect(await moveCharacterToFolder('Nobody.png', 'Fantasy')).toBeNull();
  });
});

describe('renameFolder', () => {
  test('renames in place, carrying its contents', async () => {
    card('Old', 'Alice.png');

    expect(await renameFolder('Old', 'New')).toBe('New');
    expect(existsSync(join(PATHS.characters, 'New/Alice.png'))).toBe(true);
    expect(existsSync(join(PATHS.characters, 'Old'))).toBe(false);
  });

  test('moves a folder under a different parent, since `to` is a full path', async () => {
    card('Elves', 'Alice.png');
    createFolder('Fantasy');

    expect(await renameFolder('Elves', 'Fantasy/Elves')).toBe('Fantasy/Elves');
    expect(existsSync(join(PATHS.characters, 'Fantasy/Elves/Alice.png'))).toBe(true);
  });

  test('refuses to move a folder inside itself', async () => {
    createFolder('Fantasy');
    await expect(renameFolder('Fantasy', 'Fantasy/Nested')).rejects.toThrow('inside itself');
  });

  test('refuses a genuine collision', async () => {
    createFolder('A');
    createFolder('B');
    await expect(renameFolder('A', 'B')).rejects.toThrow('already exists');
  });

  test('returns null for a folder that is not there', async () => {
    expect(await renameFolder('Nowhere', 'Somewhere')).toBeNull();
  });
});

describe('deleteFolder', () => {
  /*
   * Lifting rather than deleting is safe only because identity is flat: the cards keep their
   * filenames, so their chats and settings are untouched, and the lift cannot collide because
   * names are already unique library-wide.
   */
  test('lifts every card beneath it to the top level and removes the directory', async () => {
    card('Fantasy', 'Elf.png');
    card('Fantasy', 'Elves', 'Deep.png');

    expect(await deleteFolder('Fantasy')).toEqual({ moved: 2, skipped: [], removed: true });
    expect(existsSync(join(PATHS.characters, 'Elf.png'))).toBe(true);
    expect(existsSync(join(PATHS.characters, 'Deep.png'))).toBe(true);
    expect(existsSync(join(PATHS.characters, 'Fantasy'))).toBe(false);
  });

  test('removes an empty folder', async () => {
    createFolder('Empty');
    expect(await deleteFolder('Empty')).toEqual({ moved: 0, skipped: [], removed: true });
    expect(existsSync(join(PATHS.characters, 'Empty'))).toBe(false);
  });

  test('sweeps .DS_Store, which would otherwise make folders undeletable on a Mac', async () => {
    createFolder('Fantasy');
    writeFileSync(join(PATHS.characters, 'Fantasy/.DS_Store'), 'x');

    expect((await deleteFolder('Fantasy'))?.removed).toBe(true);
    expect(existsSync(join(PATHS.characters, 'Fantasy'))).toBe(false);
  });

  test('keeps the folder when something that is not a card is in it', async () => {
    card('Fantasy', 'Elf.png');
    writeFileSync(join(PATHS.characters, 'Fantasy/notes.txt'), 'x');

    expect(await deleteFolder('Fantasy')).toEqual({ moved: 1, skipped: [], removed: false });
    expect(existsSync(join(PATHS.characters, 'Elf.png'))).toBe(true);
    expect(existsSync(join(PATHS.characters, 'Fantasy/notes.txt'))).toBe(true);
  });

  test('leaves a card whose name is already taken at the top level', async () => {
    card('Same.png');
    card('Fantasy', 'Same.png');

    expect(await deleteFolder('Fantasy')).toEqual({
      moved: 0,
      skipped: ['Same.png'],
      removed: false,
    });
    expect(existsSync(join(PATHS.characters, 'Fantasy/Same.png'))).toBe(true);
  });

  test('returns null for a folder that is not there', async () => {
    expect(await deleteFolder('Nowhere')).toBeNull();
  });
});
