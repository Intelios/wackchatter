import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DATA_DIR,
  ensureDataDirs,
  MARKER_FILENAME,
  PATHS,
  safeJoin,
  safeJoinFolder,
  sanitizeFilename,
  sanitizeFolderPath,
  setDataDir,
  uniqueName,
} from './paths.ts';

/*
 * !! paths.ts is module state shared by every test file in the process. !!
 *
 * setDataDir mutates one object that the whole suite reads through, so a test that leaves it
 * pointed somewhere else does not fail here — it repoints every file that runs afterwards,
 * and the failure surfaces somewhere unrelated. Always put it back.
 */
afterEach(() => {
  setDataDir(DEFAULT_DATA_DIR);
});

describe('setDataDir', () => {
  test('rewrites every path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-paths-'));
    try {
      setDataDir(dir);
      expect(PATHS.root).toBe(dir);
      expect(PATHS.characters).toBe(join(dir, 'characters'));
      expect(PATHS.personaAvatars).toBe(join(dir, 'personas', 'avatars'));
      expect(PATHS.db).toBe(join(dir, 'chats.db'));
      expect(PATHS.marker).toBe(join(dir, MARKER_FILENAME));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * The invariant the whole design rests on. ~60 call sites read PATHS.x rather than taking a
   * getter, which only works because the object's identity never changes — it is rewritten in
   * place. If this ever fails, every one of those sites is silently pinned to the old root.
   */
  test('rewrites in place, so an already-held reference follows the move', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-paths-'));
    try {
      const held = PATHS;
      setDataDir(dir);
      expect(held).toBe(PATHS);
      expect(held.root).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureDataDirs', () => {
  test('creates every directory and marks the folder as ours', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-paths-'));
    try {
      setDataDir(dir);
      ensureDataDirs();

      for (const path of [
        PATHS.characters,
        PATHS.presets,
        PATHS.lorebooks,
        PATHS.personas,
        PATHS.personaAvatars,
        PATHS.backgrounds,
        PATHS.backups,
      ]) {
        expect(statSync(path).isDirectory()).toBe(true);
      }
      expect(JSON.parse(readFileSync(PATHS.marker, 'utf8'))).toMatchObject({
        app: 'wackchatter',
        version: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is idempotent, and never rewrites when the folder was first used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-paths-'));
    try {
      setDataDir(dir);
      ensureDataDirs();
      const created = JSON.parse(readFileSync(PATHS.marker, 'utf8')).created;

      ensureDataDirs();
      expect(JSON.parse(readFileSync(PATHS.marker, 'utf8')).created).toBe(created);
      expect(existsSync(PATHS.backups)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sanitizeFilename', () => {
  test('keeps ordinary names, including spaces and hyphens', () => {
    expect(sanitizeFilename('Seraphina')).toBe('Seraphina');
    expect(sanitizeFilename('My Character - v2')).toBe('My Character - v2');
    expect(sanitizeFilename('日本語のキャラ')).toBe('日本語のキャラ');
  });

  test('strips control characters', () => {
    expect(sanitizeFilename('bad\x00name')).toBe('badname');
    expect(sanitizeFilename('tab\there')).toBe('tabhere');
    expect(sanitizeFilename('newline\nhere')).toBe('newlinehere');
    expect(sanitizeFilename('del\x7fchar')).toBe('delchar');
  });

  test('strips path-significant characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  test('drops leading dots so a traversal attempt cannot make a hidden file', () => {
    // Removing the separators from "../../etc/passwd" used to leave "....etcpasswd" —
    // safely inside the data directory, but invisible to `ls` and to a file browser.
    expect(sanitizeFilename('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFilename('.hidden')).toBe('hidden');
    expect(sanitizeFilename('..')).toBeNull();
  });

  test('rejects names that reduce to nothing or to a dot path', () => {
    expect(sanitizeFilename('')).toBeNull();
    expect(sanitizeFilename('   ')).toBeNull();
    expect(sanitizeFilename('.')).toBeNull();
    expect(sanitizeFilename('..')).toBeNull();
    expect(sanitizeFilename('/')).toBeNull();
  });

  test('rejects Windows reserved device names', () => {
    expect(sanitizeFilename('CON')).toBeNull();
    expect(sanitizeFilename('nul')).toBeNull();
    expect(sanitizeFilename('COM1')).toBeNull();
    expect(sanitizeFilename('console')).toBe('console'); // not reserved
  });

  test('drops trailing dots and spaces so "foo." cannot collide with "foo"', () => {
    expect(sanitizeFilename('foo.')).toBe('foo');
    expect(sanitizeFilename('foo   ')).toBe('foo');
    expect(sanitizeFilename('foo. . ')).toBe('foo');
  });

  test('caps length', () => {
    expect(sanitizeFilename('a'.repeat(500))?.length).toBe(200);
  });
});

describe('safeJoin', () => {
  const base = '/tmp/wc-test/characters';

  test('joins an ordinary name', () => {
    expect(safeJoin(base, 'Seraphina.png')).toBe('/tmp/wc-test/characters/Seraphina.png');
  });

  test('refuses to escape the base directory', () => {
    // Separators and leading dots are both stripped, so traversal lands on an ordinary
    // visible name inside the base rather than climbing out or going hidden.
    expect(safeJoin(base, '../../../etc/passwd')).toBe('/tmp/wc-test/characters/etcpasswd');
    expect(safeJoin(base, '..')).toBeNull();
    expect(safeJoin(base, '/etc/passwd')).toBe('/tmp/wc-test/characters/etcpasswd');
  });

  test('returns null for unusable names', () => {
    expect(safeJoin(base, '')).toBeNull();
    expect(safeJoin(base, '   ')).toBeNull();
  });
});

describe('sanitizeFolderPath', () => {
  test('keeps an ordinary path and normalises separators', () => {
    expect(sanitizeFolderPath('Favourites')).toBe('Favourites');
    expect(sanitizeFolderPath('Fantasy/Elves')).toBe('Fantasy/Elves');
    expect(sanitizeFolderPath('Fantasy\\Elves')).toBe('Fantasy/Elves');
    expect(sanitizeFolderPath('/Fantasy//Elves/')).toBe('Fantasy/Elves');
  });

  test('the empty path is the root, not an error', () => {
    expect(sanitizeFolderPath('')).toBe('');
    expect(sanitizeFolderPath('   ')).toBe('');
  });

  test('cannot climb out, because every segment goes through sanitizeFilename', () => {
    expect(sanitizeFolderPath('../../etc')).toBe('etc');
    expect(sanitizeFolderPath('Fav/../Evil')).toBe('Fav/Evil');
    expect(sanitizeFolderPath('..')).toBeNull();
    expect(sanitizeFolderPath('../..')).toBeNull();
  });

  test('cannot make a hidden folder', () => {
    expect(sanitizeFolderPath('.hidden')).toBe('hidden');
    expect(sanitizeFolderPath('Fav/.git')).toBe('Fav/git');
  });

  test('refuses a path deeper than the cap', () => {
    expect(sanitizeFolderPath(Array(16).fill('a').join('/'))).toBe(Array(16).fill('a').join('/'));
    expect(sanitizeFolderPath(Array(17).fill('a').join('/'))).toBeNull();
  });
});

describe('safeJoinFolder', () => {
  const base = '/tmp/wc-test/characters';

  test('joins an ordinary folder path', () => {
    expect(safeJoinFolder(base, 'Fantasy/Elves')).toBe('/tmp/wc-test/characters/Fantasy/Elves');
  });

  test('the root resolves to the base itself', () => {
    expect(safeJoinFolder(base, '')).toBe(base);
  });

  test('refuses to escape the base directory', () => {
    expect(safeJoinFolder(base, '../../../etc')).toBe('/tmp/wc-test/characters/etc');
    expect(safeJoinFolder(base, '..')).toBeNull();
    expect(safeJoinFolder(base, '/etc/passwd')).toBe('/tmp/wc-test/characters/etc/passwd');
  });
});

describe('uniqueName', () => {
  test('returns the base when free', () => {
    expect(uniqueName('Seraphina', () => false)).toBe('Seraphina');
  });

  test('appends an index with no separator, matching SillyTavern', () => {
    const taken = new Set(['Seraphina', 'Seraphina1', 'Seraphina2']);
    expect(uniqueName('Seraphina', (c) => taken.has(c))).toBe('Seraphina3');
  });
});
