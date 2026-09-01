import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BackupManifest } from '../../shared/types/backup.ts';
import { closeDatabase, getDb, SCHEMA_VERSION } from './db.ts';
import {
  activeBackups,
  backupExclusion,
  backupStem,
  planBackup,
  startBackup,
  trackBackup,
} from './library.ts';
import { DEFAULT_DATA_DIR, ensureDataDirs, setDataDir } from './paths.ts';

let dir: string;

/** A structurally real library: nested cards, a real database, and the droppings around it. */
function seedLibrary(root: string): void {
  setDataDir(root);
  ensureDataDirs();

  writeFileSync(join(root, 'characters', 'Seraphina.png'), 'PNG-BYTES');
  mkdirSync(join(root, 'characters', 'Drafts'), { recursive: true });
  writeFileSync(join(root, 'characters', 'Drafts', 'Café ☕.png'), 'NESTED-PNG');
  mkdirSync(join(root, 'characters', 'Empty'), { recursive: true });
  writeFileSync(join(root, 'presets', 'Default.json'), '{"name":"Default"}');
  writeFileSync(join(root, 'settings.json'), '{"theme":"dark"}');
  writeFileSync(join(root, 'secrets.json'), '{"conn-1":"sk-test"}', { mode: 0o600 });

  // Everything a backup must leave behind.
  writeFileSync(join(root, '.DS_Store'), 'junk');
  writeFileSync(join(root, 'characters', '.DS_Store'), 'junk');
  writeFileSync(join(root, 'settings.json.a1b2c3d4e5f6.tmp'), 'half-written');
  writeFileSync(join(root, '.wc-write-probe-deadbeef'), '');

  getDb()
    .query(
      `INSERT INTO chats (id, character_id, title, created, modified, revision, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('c1', 'Seraphina.png', 'A chat', 1, 1, 0, '{}');
}

/** Unpack with the real tool, which is also how a user recovers one of these. */
function extract(zipPath: string, into: string): boolean {
  const unzip = Bun.which('unzip');
  if (!unzip) return false;
  mkdirSync(into, { recursive: true });
  const result = Bun.spawnSync([unzip, '-q', zipPath, '-d', into]);
  expect(result.exitCode).toBe(0);
  return true;
}

async function buildArchive(secrets: boolean): Promise<{ path: string; stem: string }> {
  const { plan, path } = await startBackup({ secrets });
  return { path, stem: plan.stem };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-library-'));
});

afterEach(() => {
  // See the warning in paths.test.ts: this object is shared by the whole process.
  closeDatabase();
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
});

describe('backupExclusion', () => {
  const withSecrets = { secrets: true };
  const withoutSecrets = { secrets: false };

  test('keeps the library', () => {
    for (const rel of [
      'characters/Seraphina.png',
      'characters/Drafts/Nested.png',
      'presets/Default.json',
      'settings.json',
      'backups/1700000000__A chat__c1.json',
      'backgrounds/sunset.jpg',
      // The one dotfile that must survive: it is what makes an unzipped backup adoptable.
      '.wackchatter',
    ]) {
      expect(backupExclusion(rel, withoutSecrets)).toBeNull();
    }
  });

  test('drops file-manager and sync-client droppings at any depth', () => {
    expect(backupExclusion('.DS_Store', withoutSecrets)).toBe('noise');
    expect(backupExclusion('characters/Drafts/.DS_Store', withoutSecrets)).toBe('noise');
    expect(backupExclusion('Thumbs.db', withoutSecrets)).toBe('noise');
  });

  test('drops writes that are still mid-rename', () => {
    expect(backupExclusion('settings.json.a1b2c3d4e5f6.tmp', withoutSecrets)).toBe('temp');
    expect(backupExclusion('.wc-write-probe-deadbeef', withoutSecrets)).toBe('temp');
    // A card genuinely named this way is not an atomicWrite sibling.
    expect(backupExclusion('characters/notes.tmp', withoutSecrets)).toBeNull();
  });

  test('drops the live database and every sidecar, which the snapshot replaces', () => {
    expect(backupExclusion('chats.db', withoutSecrets)).toBe('db');
    expect(backupExclusion('chats.db-wal', withoutSecrets)).toBe('db');
    expect(backupExclusion('chats.db-shm', withoutSecrets)).toBe('db');
    // journal_mode = DELETE in a cloud folder, per openDatabase.
    expect(backupExclusion('chats.db-journal', withoutSecrets)).toBe('db');
    // A card that merely starts the same way is still the user's file.
    expect(backupExclusion('characters/chats.db.png', withoutSecrets)).toBeNull();
  });

  test('drops its own manifest, so re-backing up a restored library cannot collide', () => {
    // Restoring is unzip-and-adopt, so a restored library keeps backup.json at its root.
    expect(backupExclusion('backup.json', withoutSecrets)).toBe('manifest');
    expect(backupExclusion('characters/backup.json', withoutSecrets)).toBeNull();
  });

  test('drops API keys unless they are asked for', () => {
    expect(backupExclusion('secrets.json', withoutSecrets)).toBe('secrets');
    expect(backupExclusion('secrets.json', withSecrets)).toBeNull();
    // Only at the root — a character folder called this is not the keys file.
    expect(backupExclusion('characters/secrets.json', withoutSecrets)).toBeNull();
  });
});

describe('backupStem', () => {
  test('names the archive by local date and time', () => {
    expect(backupStem(new Date(2026, 8, 1, 9, 5))).toBe('wackchatter-library-2026-09-01-0905');
  });
});

describe('planBackup', () => {
  test('counts nested cards, and the two files that are not on disk', () => {
    seedLibrary(dir);
    closeDatabase();

    const plan = planBackup({ secrets: false });
    // Seraphina, the nested card, the preset, settings.json, the marker, the default
    // preset ensureDataDirs seeds — plus chats.db and backup.json.
    expect(plan.files).toBeGreaterThanOrEqual(7);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(plan.filename).toBe(`${plan.stem}.zip`);
    expect(plan.includesSecrets).toBe(false);
  });

  test('including keys adds exactly one file', () => {
    seedLibrary(dir);
    closeDatabase();

    const without = planBackup({ secrets: false });
    const with_ = planBackup({ secrets: true });
    expect(with_.files - without.files).toBe(1);
    expect(with_.includesSecrets).toBe(true);
  });
});

describe('startBackup', () => {
  test('produces an archive that unzips into an adoptable library', async () => {
    seedLibrary(dir);

    const { path, stem } = await buildArchive(false);
    const into = join(dir, 'out');
    if (!extract(path, into)) return;

    // One top-level folder, so unzipping never scatters a library across Downloads.
    const root = join(into, stem);
    expect(existsSync(root)).toBe(true);

    // looksLikeLibrary() is satisfied, which is what makes Data location able to adopt it.
    expect(existsSync(join(root, 'chats.db'))).toBe(true);
    expect(existsSync(join(root, 'characters'))).toBe(true);
    expect(existsSync(join(root, 'presets'))).toBe(true);
    expect(existsSync(join(root, '.wackchatter'))).toBe(true);

    // Nested cards survive the recursion, and so does an empty folder.
    expect(readFileSync(join(root, 'characters', 'Drafts', 'Café ☕.png'), 'utf8')).toBe(
      'NESTED-PNG',
    );
    expect(existsSync(join(root, 'characters', 'Empty'))).toBe(true);

    // And none of the noise.
    expect(existsSync(join(root, '.DS_Store'))).toBe(false);
    expect(existsSync(join(root, 'characters', '.DS_Store'))).toBe(false);
    expect(existsSync(join(root, 'settings.json.a1b2c3d4e5f6.tmp'))).toBe(false);
    expect(existsSync(join(root, '.wc-write-probe-deadbeef'))).toBe(false);
    expect(existsSync(join(root, 'chats.db-wal'))).toBe(false);
  });

  test('the archived database is a real one, with the chats in it', async () => {
    seedLibrary(dir);

    const { path, stem } = await buildArchive(false);
    const into = join(dir, 'out');
    if (!extract(path, into)) return;

    const restored = new Database(join(into, stem, 'chats.db'), { readonly: true });
    try {
      expect(restored.query('PRAGMA quick_check(1)').get()).toEqual({ quick_check: 'ok' });
      expect(restored.query('SELECT id, title FROM chats').all()).toEqual([
        { id: 'c1', title: 'A chat' },
      ]);
    } finally {
      restored.close();
    }
  });

  test('carries a manifest that says what the archive is', async () => {
    seedLibrary(dir);

    const { path, stem } = await buildArchive(false);
    const into = join(dir, 'out');
    if (!extract(path, into)) return;

    const manifest = JSON.parse(
      readFileSync(join(into, stem, 'backup.json'), 'utf8'),
    ) as BackupManifest;
    expect(manifest.app).toBe('wackchatter');
    expect(manifest.kind).toBe('library-backup');
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.source).toBe(dir);
    expect(manifest.includesSecrets).toBe(false);
    expect(Number.isNaN(Date.parse(manifest.created))).toBe(false);
  });

  test('leaves API keys out unless asked, and includes them when asked', async () => {
    seedLibrary(dir);

    const plain = await buildArchive(false);
    const plainInto = join(dir, 'plain');
    if (!extract(plain.path, plainInto)) return;
    expect(existsSync(join(plainInto, plain.stem, 'secrets.json'))).toBe(false);

    const keyed = await buildArchive(true);
    const keyedInto = join(dir, 'keyed');
    extract(keyed.path, keyedInto);
    expect(readFileSync(join(keyedInto, keyed.stem, 'secrets.json'), 'utf8')).toBe(
      '{"conn-1":"sk-test"}',
    );
  });

  test('holds the folder only while it is reading, and cleans up after itself', async () => {
    seedLibrary(dir);

    expect(activeBackups()).toBe(0);
    const { path, dispose } = await startBackup({ secrets: false });

    /*
     * Zero again already: the slot covers the walk, and by the time startBackup returns the
     * archive is a finished file. Holding it through the download would refuse folder moves
     * long after a move could do any harm.
     */
    expect(activeBackups()).toBe(0);
    expect(existsSync(path)).toBe(true);

    // The database snapshot shares the archive's token and exists only to be archived, so
    // it must not outlive the walk.
    const token = basename(path).slice(0, -'.zip'.length);
    expect(readdirSync(tmpdir()).filter((name) => name === `${token}.db`)).toEqual([]);

    dispose();
    expect(existsSync(path)).toBe(false);
    // Disposing twice is what a timer racing a sweep looks like; it must not throw.
    expect(() => dispose()).not.toThrow();
  });
});

describe('activeBackups', () => {
  test('counts what is in flight and forgets what leaked', () => {
    expect(activeBackups()).toBe(0);

    const release = trackBackup();
    expect(activeBackups()).toBe(1);
    release();
    expect(activeBackups()).toBe(0);

    // Calling it twice must not go negative or throw.
    release();
    expect(activeBackups()).toBe(0);
  });
});
