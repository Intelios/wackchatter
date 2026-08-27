import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DATA_DIR, ensureDataDirs, PATHS, setDataDir } from './paths.ts';
import {
  createPersona,
  createVariant,
  deletePersona,
  getPersona,
  nextVariantLabel,
  savePersona,
} from './personas.ts';

/*
 * !! paths.ts is module state shared by every test file in the process. !! These tests point
 * it at a temp directory; the afterEach puts it back, same rule as paths.test.ts.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-personas-'));
  setDataDir(dir);
  ensureDataDirs();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setDataDir(DEFAULT_DATA_DIR);
});

/** The persona's file as written on disk, before any normalisation. */
function rawFile(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PATHS.personas, `${id}.json`), 'utf8'));
}

describe('persona variant fields', () => {
  test('survive a save round-trip', async () => {
    const base = await createPersona('John Doe');
    const variant = await createVariant(base.id, 'Fantasy');

    expect(variant.variantOf).toBe(base.id);
    expect(variant.variantLabel).toBe('Fantasy');
    expect(getPersona(variant.id)?.variantOf).toBe(base.id);

    // On disk too — a hand-editable format is only kind if what we write is what we read.
    expect(rawFile(variant.id).variantOf).toBe(base.id);
    expect(rawFile(variant.id).variantLabel).toBe('Fantasy');
  });

  test('garbage is dropped by normalisation, never thrown back', () => {
    const id = crypto.randomUUID();
    writeFileSync(
      join(PATHS.personas, `${id}.json`),
      JSON.stringify({
        name: 'John Doe',
        variantOf: '', // empty — not a link
        variantLabel: 42, // not a string
        thirdPartyKey: 'dropped, like every unknown key',
      }),
    );

    const persona = getPersona(id);
    expect(persona?.variantOf).toBeUndefined();
    expect(persona?.variantLabel).toBeUndefined();
    expect((persona as unknown as Record<string, unknown>).thirdPartyKey).toBeUndefined();
    expect(rawFile(id).thirdPartyKey).toBe('dropped, like every unknown key');
  });

  test('a self-reference is not a link', () => {
    const id = crypto.randomUUID();
    writeFileSync(
      join(PATHS.personas, `${id}.json`),
      JSON.stringify({ name: 'John Doe', variantOf: id }),
    );
    expect(getPersona(id)?.variantOf).toBeUndefined();
  });

  test('a null patch unlinks and unlabels — the fields leave the file', async () => {
    const base = await createPersona('John Doe');
    const variant = await createVariant(base.id, 'Fantasy');

    const after = await savePersona(variant.id, { variantOf: null, variantLabel: null });
    expect(after.variantOf).toBeUndefined();
    expect(after.variantLabel).toBeUndefined();
    expect(rawFile(variant.id).variantOf).toBeUndefined();
    expect(rawFile(variant.id).variantLabel).toBeUndefined();
  });
});

describe('createVariant', () => {
  test('copies the whole persona — everything but the identity', async () => {
    const base = await createPersona('John Doe');
    await savePersona(base.id, {
      description: 'A quiet accountant.',
      position: 'atDepth',
      depth: 4,
      role: 'user',
      lorebookId: 'book-1',
    });

    const variant = await createVariant(base.id, 'Sci-fi');
    expect(variant.name).toBe('John Doe');
    expect(variant.description).toBe('A quiet accountant.');
    expect(variant.position).toBe('atDepth');
    expect(variant.depth).toBe(4);
    expect(variant.role).toBe('user');
    expect(variant.lorebookId).toBe('book-1');
    expect(variant.id).not.toBe(base.id);
  });

  test('a blank label falls back to the first unused default', async () => {
    const base = await createPersona('John Doe');
    expect((await createVariant(base.id)).variantLabel).toBe('Variant');
    expect((await createVariant(base.id, '  ')).variantLabel).toBe('Variant 2');
  });

  test('default labels skip ones the base already has, case-insensitively', async () => {
    const base = await createPersona('John Doe');
    await createVariant(base.id, 'variant 2'); // lowercase occupies the slot
    expect((await createVariant(base.id)).variantLabel).toBe('Variant');
    expect((await createVariant(base.id)).variantLabel).toBe('Variant 3');
  });

  test('a variant of a variant joins the same base — one level, never a chain', async () => {
    const base = await createPersona('John Doe');
    const first = await createVariant(base.id, 'Fantasy');
    const second = await createVariant(first.id, 'Sci-fi');

    expect(second.variantOf).toBe(base.id);
    expect(second.variantLabel).toBe('Sci-fi');
  });

  test('copies the avatar file, so replacing either face leaves the other alone', async () => {
    const base = await createPersona('John Doe');
    const avatarBytes = 'not really a png';
    writeFileSync(join(PATHS.personaAvatars, `${base.id}.png`), avatarBytes);
    await savePersona(base.id, { avatar: `${base.id}.png` });

    const variant = await createVariant(base.id, 'Fantasy');
    expect(variant.avatar).toBe(`${variant.id}.png`);
    expect(existsSync(join(PATHS.personaAvatars, `${variant.id}.png`))).toBe(true);
    expect(existsSync(join(PATHS.personaAvatars, `${base.id}.png`))).toBe(true);
    expect(readFileSync(join(PATHS.personaAvatars, `${variant.id}.png`), 'utf8')).toBe(avatarBytes);
  });

  test('a missing avatar file degrades to no avatar', async () => {
    const base = await createPersona('John Doe');
    await savePersona(base.id, { avatar: `${base.id}.png` }); // the field points at nothing

    const variant = await createVariant(base.id, 'Fantasy');
    expect(variant.avatar).toBeNull();
  });

  test('a missing base throws rather than minting an orphan', async () => {
    expect(createVariant('no-such-persona')).rejects.toThrow('Persona not found.');
  });

  test('deleting the base severs the link but leaves the variant untouched', async () => {
    const base = await createPersona('John Doe');
    const variant = await createVariant(base.id, 'Fantasy');

    expect(deletePersona(base.id)).toBe(true);
    const survivor = getPersona(variant.id);
    expect(survivor?.name).toBe('John Doe');
    // The id stays recorded: nothing resolves it server-side, and the client renders an
    // unresolvable variantOf as a standalone persona.
    expect(survivor?.variantOf).toBe(base.id);
  });
});

describe('nextVariantLabel', () => {
  test('starts at Variant and counts up', () => {
    expect(nextVariantLabel([])).toBe('Variant');
    expect(nextVariantLabel(['Variant'])).toBe('Variant 2');
    expect(nextVariantLabel(['Variant', 'Variant 2'])).toBe('Variant 3');
  });

  test('matches case-insensitively and ignores blanks', () => {
    expect(nextVariantLabel(['variant'])).toBe('Variant 2');
    expect(nextVariantLabel([''])).toBe('Variant');
  });

  test('fills gaps rather than always appending', () => {
    expect(nextVariantLabel(['Variant', 'Variant 3'])).toBe('Variant 2');
  });
});
