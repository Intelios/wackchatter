import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlankCard, mergeCardData, readCard, writeCard } from './card.ts';
import { updateWorldLinks, updateWorldLinksRecoverable } from './characters.ts';

/**
 * The same 1x1 transparent PNG characters.ts uses as a carrier for imageless cards. Inlined
 * so the cascade can be tested against real card files without touching the data directory.
 */
const BLANK_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-references-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCardFile(filename: string, world?: string): void {
  const card = mergeCardData(createBlankCard(filename), world ? { extensions: { world } } : {});
  writeFileSync(join(dir, filename), writeCard(BLANK_PNG, card));
}

function worldOf(filename: string): string | undefined {
  return readCard(new Uint8Array(readFileSync(join(dir, filename)))).data.extensions?.world;
}

describe('updateWorldLinks', () => {
  test('a rename repoints only the cards that linked the old book', async () => {
    writeCardFile('Linked.png', 'OldBook');
    writeCardFile('AlsoLinked.png', 'OldBook');
    writeCardFile('Elsewhere.png', 'OtherBook');
    writeCardFile('Unlinked.png');

    expect(await updateWorldLinks('OldBook', 'NewBook', dir)).toBe(2);

    expect(worldOf('Linked.png')).toBe('NewBook');
    expect(worldOf('AlsoLinked.png')).toBe('NewBook');
    expect(worldOf('Elsewhere.png')).toBe('OtherBook');
    expect(worldOf('Unlinked.png')).toBeUndefined();
  });

  test('a delete clears the link rather than leaving a dangling name', async () => {
    writeCardFile('Linked.png', 'Doomed');
    writeCardFile('Safe.png', 'Kept');

    expect(await updateWorldLinks('Doomed', null, dir)).toBe(1);

    expect(worldOf('Linked.png')).toBeUndefined();
    expect(worldOf('Safe.png')).toBe('Kept');
  });

  test('unknown keys on the card survive the rewrite', async () => {
    // A third-party key must ride out a lorebook rename, exactly as a normal edit does.
    const card = mergeCardData(createBlankCard('Vendor.png'), {
      extensions: { world: 'OldBook', chub: 'vendor-id' },
    });
    writeFileSync(join(dir, 'Vendor.png'), writeCard(BLANK_PNG, card));

    await updateWorldLinks('OldBook', 'NewBook', dir);

    const reread = readCard(new Uint8Array(readFileSync(join(dir, 'Vendor.png'))));
    expect(reread.data.extensions?.world).toBe('NewBook');
    expect(reread.data.extensions?.chub).toBe('vendor-id');
  });

  test('a missing directory is a quiet no-op', async () => {
    expect(await updateWorldLinks('OldBook', 'NewBook', join(dir, 'nope'))).toBe(0);
  });

  test('non-PNG files are ignored', async () => {
    writeCardFile('Linked.png', 'OldBook');
    writeFileSync(join(dir, 'notes.txt'), 'not a card');

    expect(await updateWorldLinks('OldBook', 'NewBook', dir)).toBe(1);
    expect(readdirSync(dir)).toContain('notes.txt');
  });

  test('a successful rewrite supplies an exact rollback', async () => {
    writeCardFile('Changed.png', 'OldBook');
    writeCardFile('AlreadyNew.png', 'NewBook');

    const rollback = await updateWorldLinksRecoverable('OldBook', 'NewBook', dir);
    expect(worldOf('Changed.png')).toBe('NewBook');
    expect(worldOf('AlreadyNew.png')).toBe('NewBook');

    await rollback();
    expect(worldOf('Changed.png')).toBe('OldBook');
    // The rollback targets only files changed by its own forward pass.
    expect(worldOf('AlreadyNew.png')).toBe('NewBook');
  });

  test('a delete rewrite can be rolled back without touching unrelated unlinked cards', async () => {
    writeCardFile('Changed.png', 'Doomed');
    writeCardFile('Unlinked.png');

    const rollback = await updateWorldLinksRecoverable('Doomed', null, dir);
    expect(worldOf('Changed.png')).toBeUndefined();

    await rollback();
    expect(worldOf('Changed.png')).toBe('Doomed');
    expect(worldOf('Unlinked.png')).toBeUndefined();
  });
});
