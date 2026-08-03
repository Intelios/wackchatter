import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDb } from './db.ts';
import { DEFAULT_DATA_DIR, ensureDataDirs, setDataDir } from './paths.ts';
import { moveLibrary, shouldUseRename } from './transfer.ts';

let dir: string;

/** A small but structurally real library: files, a marked folder, and an actual database. */
function seedLibrary(root: string): void {
  setDataDir(root);
  ensureDataDirs();
  writeFileSync(join(root, 'characters', 'Seraphina.png'), 'PNG-BYTES');
  writeFileSync(join(root, 'presets', 'Default.json'), '{"name":"Default"}');
  writeFileSync(join(root, 'secrets.json'), '{"openai":"sk-test"}', { mode: 0o600 });

  getDb()
    .query(
      `INSERT INTO chats (id, character_id, title, created, modified, revision, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('c1', 'Seraphina.png', 'A chat', 1, 1, 0, '{}');
  closeDatabase();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-transfer-'));
});

afterEach(() => {
  // See the warning in paths.test.ts: this object is shared by the whole process.
  closeDatabase();
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
});

describe('shouldUseRename', () => {
  // The cross-device path cannot be exercised without two real volumes, so the decision is
  // testable on its own and the copy itself is reached with forceCopy.
  test('only within one filesystem, and only onto a name that is free', () => {
    expect(shouldUseRename(1, 1, false)).toBe(true);
    expect(shouldUseRename(1, 2, false)).toBe(false);
    expect(shouldUseRename(1, 1, true)).toBe(false);
    expect(shouldUseRename(null, 1, false)).toBe(false);
  });
});

describe('closeDatabase', () => {
  test('leaves one self-contained file, with the log folded in', () => {
    const root = join(dir, 'data');
    seedLibrary(root);

    expect(existsSync(join(root, 'chats.db'))).toBe(true);
    expect(existsSync(join(root, 'chats.db-wal'))).toBe(false);
    expect(existsSync(join(root, 'chats.db-shm'))).toBe(false);
  });

  test('is a no-op when called again', () => {
    seedLibrary(join(dir, 'data'));
    expect(() => closeDatabase()).not.toThrow();
  });

  test('reopens against the current root after a move', () => {
    const root = join(dir, 'data');
    seedLibrary(root);

    setDataDir(join(dir, 'elsewhere'));
    ensureDataDirs();
    // A fresh database at the new root, not the one seeded at the old one.
    expect(getDb().query('SELECT count(*) AS n FROM chats').get()).toMatchObject({ n: 0 });
  });
});

describe.each([
  ['same-disk rename', false, 'rename'],
  ['cross-disk copy', true, 'copy'],
] as const)('moveLibrary — %s', (_label, forceCopy, strategy) => {
  test('moves every file and keeps the chats readable', async () => {
    const source = join(dir, 'data');
    const destination = join(dir, 'moved');
    seedLibrary(source);

    const outcome = await moveLibrary(source, destination, { forceCopy });
    expect(outcome.strategy).toBe(strategy);

    expect(readFileSync(join(destination, 'characters', 'Seraphina.png'), 'utf8')).toBe(
      'PNG-BYTES',
    );
    expect(readFileSync(join(destination, 'presets', 'Default.json'), 'utf8')).toContain('Default');

    const moved = new Database(join(destination, 'chats.db'), { readonly: true });
    try {
      expect(moved.query('SELECT title FROM chats WHERE id = ?').get('c1')).toMatchObject({
        title: 'A chat',
      });
      expect(moved.query('PRAGMA quick_check(1)').get()).toMatchObject({ quick_check: 'ok' });
    } finally {
      moved.close();
    }
  });

  test('carries no write-ahead log to the destination', async () => {
    const source = join(dir, 'data');
    const destination = join(dir, 'moved');
    seedLibrary(source);

    await moveLibrary(source, destination, { forceCopy });
    expect(existsSync(join(destination, 'chats.db-wal'))).toBe(false);
    expect(existsSync(join(destination, 'chats.db-shm'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('keeps the API keys unreadable by others', async () => {
    const source = join(dir, 'data');
    const destination = join(dir, 'moved');
    seedLibrary(source);

    const outcome = await moveLibrary(source, destination, { forceCopy });
    expect(statSync(join(destination, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(outcome.warnings).toEqual([]);
  });

  test('leaves the source alone until finish is called', async () => {
    const source = join(dir, 'data');
    const destination = join(dir, 'moved');
    seedLibrary(source);

    const outcome = await moveLibrary(source, destination, { forceCopy });
    // A rename consumes the source by definition; a copy must not, until we say so.
    if (strategy === 'copy') {
      expect(existsSync(join(source, 'characters', 'Seraphina.png'))).toBe(true);
    }

    const kept = await outcome.finish();
    expect(existsSync(source)).toBe(false);
    // A copy renames the old library aside rather than deleting it.
    expect(kept === null).toBe(strategy === 'rename');
    if (kept) expect(existsSync(join(kept, 'characters', 'Seraphina.png'))).toBe(true);
  });
});

describe('moveLibrary failures', () => {
  test('refuses to move a database that something still has open', async () => {
    const source = join(dir, 'data');
    seedLibrary(source);
    // Reopening recreates the sidecars, which is exactly the signal the guard looks for.
    getDb();

    expect(moveLibrary(source, join(dir, 'moved'))).rejects.toThrow(/still open/);
  });

  test.skipIf(process.getuid?.() === 0)(
    'a failed copy leaves the source intact and creates nothing',
    async () => {
      const source = join(dir, 'data');
      const parent = join(dir, 'readonly');
      seedLibrary(source);

      // Root ignores mode bits, which is why this is skipped there rather than made to pass.
      require('node:fs').mkdirSync(parent);
      chmodSync(parent, 0o500);
      try {
        expect(moveLibrary(source, join(parent, 'moved'), { forceCopy: true })).rejects.toThrow();
        expect(readFileSync(join(source, 'characters', 'Seraphina.png'), 'utf8')).toBe('PNG-BYTES');
        expect(existsSync(join(parent, 'moved'))).toBe(false);
      } finally {
        chmodSync(parent, 0o700);
      }
    },
  );

  test('undo puts a copied library back', async () => {
    const source = join(dir, 'data');
    const destination = join(dir, 'moved');
    seedLibrary(source);

    const outcome = await moveLibrary(source, destination, { forceCopy: true });
    await outcome.undo();

    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(source, 'characters', 'Seraphina.png'), 'utf8')).toBe('PNG-BYTES');
  });

  test('undo reverses a rename', async () => {
    const source = join(dir, 'data');
    const destination = join(dir, 'moved');
    seedLibrary(source);

    const outcome = await moveLibrary(source, destination);
    await outcome.undo();

    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(source, 'characters', 'Seraphina.png'), 'utf8')).toBe('PNG-BYTES');
  });
});

describe('journal mode', () => {
  test('a synced folder gets no write-ahead log at all', () => {
    const root = join(dir, 'Dropbox', 'WackChatter');
    setDataDir(root);
    ensureDataDirs();

    expect(getDb().query('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' });
    expect(existsSync(join(root, 'chats.db-wal'))).toBe(false);
  });

  test('an ordinary folder keeps WAL, which is faster', () => {
    setDataDir(join(dir, 'data'));
    ensureDataDirs();

    expect(getDb().query('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
  });
});
