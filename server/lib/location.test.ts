import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configDir,
  detectCloudProvider,
  inspectLocation,
  locationWarnings,
  pointerPath,
  readPointer,
  resolveDataDir,
  writePointer,
} from './location.ts';
import {
  DEFAULT_DATA_DIR,
  ensureDataDirs,
  PROJECT_ROOT,
  setDataDir,
  writeMarker,
} from './paths.ts';

let dir: string;
/** A pointer file of our own, so tests never touch the real OS config directory. */
let pointer: string;
const originalDataDir = process.env.WC_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-location-'));
  pointer = join(dir, 'config', 'location.json');
  delete process.env.WC_DATA_DIR;
});

afterEach(() => {
  /*
   * paths.ts holds one mutable object shared by the whole `bun test` process, so a test that
   * calls setDataDir and does not put it back silently repoints every test file that runs
   * after it. Restore it here, not just where it is used.
   */
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.WC_DATA_DIR;
  else process.env.WC_DATA_DIR = originalDataDir;
});

describe('configDir', () => {
  // All three branches, on whichever platform the suite happens to run — which is the whole
  // reason configDir takes its environment as arguments.
  test('macOS uses Application Support', () => {
    expect(configDir({}, 'darwin', '/Users/x')).toBe(
      '/Users/x/Library/Application Support/WackChatter',
    );
  });

  test('Windows prefers APPDATA and falls back to the roaming profile', () => {
    expect(
      configDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32', 'C:\\Users\\x'),
    ).toContain('WackChatter');
    expect(configDir({}, 'win32', '/home/x')).toBe('/home/x/AppData/Roaming/WackChatter');
  });

  test('Linux honours XDG_CONFIG_HOME, treating empty as unset', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/x')).toBe('/cfg/wackchatter');
    expect(configDir({ XDG_CONFIG_HOME: '' }, 'linux', '/home/x')).toBe(
      '/home/x/.config/wackchatter',
    );
    expect(configDir({}, 'linux', '/home/x')).toBe('/home/x/.config/wackchatter');
  });

  test('pointerPath sits inside the config directory', () => {
    expect(pointerPath('/cfg')).toBe('/cfg/location.json');
  });
});

describe('readPointer', () => {
  test('a missing file is simply no pointer', () => {
    expect(readPointer(pointer)).toBeNull();
  });

  // Every one of these runs before the app can start, so none of them may throw.
  test('unusable contents degrade to no pointer rather than throwing', () => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    for (const contents of [
      'not json at all',
      '{"version":2,"dataDir":"/x"}',
      '{"version":1,"dataDir":42}',
      '{"version":1,"dataDir":"   "}',
      '{"version":1}',
      '[]',
      'null',
    ]) {
      writeFileSync(pointer, contents);
      expect(readPointer(pointer)).toBeNull();
    }
  });

  test('resolves the recorded path', async () => {
    await writePointer(join(dir, 'lib'), pointer);
    expect(readPointer(pointer)?.dataDir).toBe(join(dir, 'lib'));
  });
});

describe('writePointer', () => {
  test('choosing the default deletes the file, because absence means default', async () => {
    await writePointer(join(dir, 'lib'), pointer);
    expect(readPointer(pointer)).not.toBeNull();

    await writePointer(DEFAULT_DATA_DIR, pointer);
    expect(readPointer(pointer)).toBeNull();
  });
});

describe('resolveDataDir', () => {
  test('WC_DATA_DIR wins outright and the pointer is not even consulted', async () => {
    await writePointer(join(dir, 'lib'), pointer);
    process.env.WC_DATA_DIR = join(dir, 'from-env');

    const resolved = resolveDataDir(pointer);
    expect(resolved.source).toBe('env');
    expect(resolved.dir).toBe(join(dir, 'from-env'));
  });

  test('no pointer means the default', () => {
    const resolved = resolveDataDir(pointer);
    expect(resolved.source).toBe('default');
    expect(resolved.dir).toBe(DEFAULT_DATA_DIR);
  });

  test('an empty directory is used, since it will be seeded', async () => {
    const target = join(dir, 'fresh');
    mkdirSync(target);
    await writePointer(target, pointer);

    expect(resolveDataDir(pointer)).toMatchObject({ dir: target, source: 'pointer' });
  });

  test('a marked directory is used', async () => {
    const target = join(dir, 'library');
    mkdirSync(target);
    writeMarker(target);
    writeFileSync(join(target, 'whatever.txt'), 'x');
    await writePointer(target, pointer);

    expect(resolveDataDir(pointer).source).toBe('pointer');
  });

  /*
   * The regression that would quietly discard someone's configuration the first time they
   * unplugged an external drive. Falling back is correct; rewriting the pointer is not.
   */
  test('an unreachable directory falls back WITHOUT touching the pointer file', async () => {
    const target = join(dir, 'unplugged');
    await writePointer(target, pointer);
    const before = readFileSync(pointer, 'utf8');

    const resolved = resolveDataDir(pointer);
    expect(resolved).toMatchObject({
      dir: DEFAULT_DATA_DIR,
      source: 'default',
      unreachable: target,
      reason: 'missing',
    });
    expect(readFileSync(pointer, 'utf8')).toBe(before);
  });

  test('a file where a folder should be falls back', async () => {
    const target = join(dir, 'afile');
    writeFileSync(target, 'x');
    await writePointer(target, pointer);

    expect(resolveDataDir(pointer).reason).toBe('not-a-directory');
  });

  test("someone else's full folder falls back rather than being scribbled in", async () => {
    const target = join(dir, 'documents');
    mkdirSync(target);
    writeFileSync(join(target, 'taxes.pdf'), 'x');
    await writePointer(target, pointer);

    expect(resolveDataDir(pointer).reason).toBe('foreign-contents');
  });

  test('sync-client droppings do not make a folder look occupied', async () => {
    const target = join(dir, 'fresh-ish');
    mkdirSync(target);
    writeFileSync(join(target, '.DS_Store'), 'x');
    await writePointer(target, pointer);

    expect(resolveDataDir(pointer).source).toBe('pointer');
  });
});

describe('inspectLocation guards', () => {
  const current = () => join(dir, 'current');

  test.each([
    ['an empty path', '', 'invalid'],
    ['a relative path', 'somewhere/else', 'not-absolute'],
    ['the filesystem root', '/', 'filesystem-root'],
    ['a system directory', '/usr/local/wc', 'system-dir'],
    ['the home directory itself', homedir(), 'home-dir'],
    ['inside the app checkout', join(PROJECT_ROOT, 'server', 'lib'), 'inside-project'],
  ] as const)('rejects %s', (_label, input, code) => {
    const verdict = inspectLocation(input, current());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe(code);
  });

  test('accepts the default folder, which is the reset target', () => {
    expect(inspectLocation(DEFAULT_DATA_DIR, current()).ok).toBe(true);
  });

  /*
   * The guard most likely to be written wrong: without resolving symlinks first, every
   * containment check below is trivially defeated by one.
   */
  test('rejects a symlink that points at a system directory', () => {
    const link = join(dir, 'innocent-looking');
    symlinkSync('/usr', link);

    const verdict = inspectLocation(link, current());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('system-dir');
  });

  test('rejects nesting in either direction, because a copy would recurse', () => {
    mkdirSync(current(), { recursive: true });

    const inside = inspectLocation(join(current(), 'inner'), current());
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.code).toBe('nested');

    const outside = inspectLocation(dir, current());
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe('nested');
  });

  test('the current folder is not an error, just nothing to do', () => {
    mkdirSync(current(), { recursive: true });
    const verdict = inspectLocation(current(), current());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.kind).toBe('same');
  });

  test('rejects a missing parent rather than creating a chain of folders', () => {
    const verdict = inspectLocation(join(dir, 'no', 'such', 'parent'), current());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('parent-missing');
  });

  test('rejects a file', () => {
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'x');

    const verdict = inspectLocation(file, current());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('not-a-directory');
  });
});

describe('inspectLocation classification', () => {
  const current = () => join(dir, 'current');

  test('an absent or empty folder is somewhere to move into', () => {
    const verdict = inspectLocation(join(dir, 'new'), current());
    expect(verdict.ok && verdict.kind).toBe('empty');
  });

  test('a folder holding only droppings still counts as empty', () => {
    const target = join(dir, 'nearly-empty');
    mkdirSync(target);
    writeFileSync(join(target, '.DS_Store'), 'x');

    expect(inspectLocation(target, current())).toMatchObject({ ok: true, kind: 'empty' });
  });

  test('a marked folder is a library, and its contents are summarised', () => {
    const target = join(dir, 'library');
    setDataDir(target);
    ensureDataDirs();
    writeFileSync(join(target, 'characters', 'a.png'), 'x');
    writeFileSync(join(target, 'characters', 'b.png'), 'x');
    writeFileSync(join(target, 'presets', 'Default.json'), '{}');

    const verdict = inspectLocation(target, current());
    expect(verdict).toMatchObject({ ok: true, kind: 'library' });
    if (verdict.ok) {
      expect(verdict.library).toMatchObject({ characters: 2, presets: 1, markerMissing: false });
    }
  });

  test('a hand-copied library without a marker is still recognised', () => {
    const target = join(dir, 'legacy');
    mkdirSync(target);
    writeFileSync(join(target, 'chats.db'), 'x');

    const verdict = inspectLocation(target, current());
    expect(verdict).toMatchObject({ ok: true, kind: 'library' });
    if (verdict.ok) expect(verdict.library?.markerMissing).toBe(true);
  });

  test("a stranger's folder is refused, and the message names what is in it", () => {
    const target = join(dir, 'documents');
    mkdirSync(target);
    writeFileSync(join(target, 'taxes.pdf'), 'x');

    const verdict = inspectLocation(target, current());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('occupied');
      expect(verdict.message).toContain('taxes.pdf');
    }
  });
});

describe('detectCloudProvider', () => {
  test.each([
    ['/Users/j/Dropbox/lib', 'Dropbox'],
    ['/Users/j/Dropbox (Personal)/lib', 'Dropbox'],
    ['/Users/j/Library/Mobile Documents/com~apple~CloudDocs/lib', 'iCloud Drive'],
    ['/Users/j/OneDrive - Contoso/lib', 'OneDrive'],
    ['/Users/j/Google Drive/My Drive/lib', 'Google Drive'],
    ['/Users/j/Nextcloud/lib', 'Nextcloud'],
  ])('recognises %s', (path, provider) => {
    expect(detectCloudProvider(path)).toBe(provider);
  });

  test('a named provider beats the generic CloudStorage mount point', () => {
    expect(detectCloudProvider('/Users/j/Library/CloudStorage/OneDrive-Corp/lib')).toBe('OneDrive');
    expect(detectCloudProvider('/Users/j/Library/CloudStorage/Whatever/lib')).toBe(
      'a cloud folder',
    );
  });

  /*
   * Segment matching, not substring. A false alarm here is not harmless: it teaches the user
   * to click past the warning that does matter.
   */
  test.each([
    '/Users/j/Documents/Dropboxes/lib',
    '/Users/j/mysync/lib',
    '/Users/j/Sync/lib',
    '/Users/j/boxes/lib',
  ])('does not fire on %s', (path) => {
    expect(detectCloudProvider(path)).toBeNull();
  });

  test('a cloud path warns about the database and the API keys, in that order', () => {
    const warnings = locationWarnings('/Users/j/Dropbox/lib');
    expect(warnings.map((w) => w.kind)).toEqual(['cloud', 'secrets']);
  });
});
