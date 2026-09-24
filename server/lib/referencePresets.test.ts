import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultPreset } from '../../shared/prompt/defaults.ts';
import { serializePreset } from '../../shared/prompt/preset-io.ts';
import { handleReferencePresetRoute } from '../routes/referencePresets.ts';
import { DEFAULT_DATA_DIR, PATHS, setDataDir } from './paths.ts';
import {
  copyPresetToReferences,
  deleteReferencePreset,
  getReferencePreset,
  importReferencePreset,
  listReferencePresets,
} from './referencePresets.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-reference-presets-'));
  setDataDir(dir);
  mkdirSync(PATHS.referencePresets, { recursive: true });
  mkdirSync(PATHS.presets, { recursive: true });
});

afterEach(() => {
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
});

describe('reference presets', () => {
  test('an empty folder lists nothing', () => {
    expect(listReferencePresets()).toEqual([]);
  });

  test('files land in the list, sorted by name', async () => {
    await importReferencePreset(serializePreset(createDefaultPreset()), 'Beta.json');
    await importReferencePreset(serializePreset(createDefaultPreset()), 'Alpha.json');

    expect(listReferencePresets().map((entry) => entry.name)).toEqual(['Alpha', 'Beta']);
  });

  test('non-json files are ignored', () => {
    writeFileSync(join(PATHS.referencePresets, 'notes.txt'), 'not a preset');
    expect(listReferencePresets()).toEqual([]);
  });

  test('get returns the verbatim file, its hash, and the normalised view', () => {
    const raw = serializePreset({ ...createDefaultPreset(), temperature: 1.4 });
    writeFileSync(join(PATHS.referencePresets, 'Kept.json'), raw);

    const record = getReferencePreset('Kept');
    expect(record).not.toBeNull();
    expect(record!.raw).toBe(raw);
    expect(record!.preset.temperature).toBe(1.4);
    expect(record!.version).toMatch(/^[0-9a-f]{64}$/);
  });

  test('get returns null for a missing id and stays inside the folder', () => {
    expect(getReferencePreset('Nope')).toBeNull();
    expect(getReferencePreset('../secrets')).toBeNull();
  });

  test('get throws on a file that is not a usable preset', () => {
    writeFileSync(join(PATHS.referencePresets, 'Broken.json'), '"just a string"');
    expect(() => getReferencePreset('Broken')).toThrow(/not a usable preset/);
  });

  test('import stores the bytes verbatim under a sanitised unique name', async () => {
    const raw = serializePreset(createDefaultPreset());
    const first = await importReferencePreset(raw, 'Found Online.json');
    const second = await importReferencePreset(raw, 'Found Online.json');

    expect(first.id).toBe('Found Online');
    expect(second.id).toBe('Found Online1');
    expect(readFileSync(join(PATHS.referencePresets, 'Found Online.json'), 'utf8')).toBe(raw);
  });

  test('import rejects text that is not a preset', async () => {
    await expect(importReferencePreset('not json', 'Bad.json')).rejects.toThrow();
    await expect(importReferencePreset('42', 'Bad.json')).rejects.toThrow();
    expect(listReferencePresets()).toEqual([]);
  });

  test('delete removes the file and tolerates repeats', async () => {
    await importReferencePreset(serializePreset(createDefaultPreset()), 'Gone.json');
    expect(await deleteReferencePreset('Gone')).toBe(true);
    expect(getReferencePreset('Gone')).toBeNull();
    expect(await deleteReferencePreset('Gone')).toBe(false);
  });

  test('the route lists, reads, imports, and deletes', async () => {
    const list = await handleReferencePresetRoute(new Request('http://x/api'), []);
    expect(list?.status).toBe(200);
    expect(await list?.json()).toEqual([]);

    const form = new FormData();
    form.set('file', new File([serializePreset(createDefaultPreset())], 'Ref.json'));
    const imported = await handleReferencePresetRoute(
      new Request('http://x/api', { method: 'POST', body: form }),
      ['import'],
    );
    expect(imported?.status).toBe(201);

    const read = await handleReferencePresetRoute(new Request('http://x/api'), ['Ref']);
    expect(read?.status).toBe(200);
    const record = (await read?.json()) as { name: string; raw: string };
    expect(record.name).toBe('Ref');
    expect(record.raw).toBe(serializePreset(createDefaultPreset()));

    const missing = await handleReferencePresetRoute(new Request('http://x/api'), ['Nope']);
    expect(missing?.status).toBe(404);

    const deleted = await handleReferencePresetRoute(
      new Request('http://x/api', { method: 'DELETE' }),
      ['Ref'],
    );
    expect(deleted?.status).toBe(200);
    expect(getReferencePreset('Ref')).toBeNull();
  });

  describe('copying a library preset', () => {
    // Deliberately not serializePreset's exact output — the copy must be the file's bytes,
    // not a re-serialisation of what the app parsed from them.
    const raw = `${serializePreset({ ...createDefaultPreset(), temperature: 0.77 })}\n`;

    test('stores the library file byte-for-byte under the preset name', async () => {
      writeFileSync(join(PATHS.presets, 'Mine.json'), raw);

      const copied = await copyPresetToReferences('Mine');
      expect(copied?.id).toBe('Mine');
      expect(readFileSync(join(PATHS.referencePresets, 'Mine.json'), 'utf8')).toBe(raw);
      expect(readFileSync(join(PATHS.presets, 'Mine.json'), 'utf8')).toBe(raw);
    });

    test('a taken name gets a numeric suffix', async () => {
      writeFileSync(join(PATHS.presets, 'Mine.json'), raw);
      await copyPresetToReferences('Mine');
      const second = await copyPresetToReferences('Mine');

      expect(second?.id).toBe('Mine1');
      expect(listReferencePresets().map((entry) => entry.id)).toEqual(['Mine', 'Mine1']);
    });

    test('a missing or escaping id copies nothing', async () => {
      writeFileSync(join(dir, 'outside.json'), raw);
      expect(await copyPresetToReferences('Nope')).toBeNull();
      expect(await copyPresetToReferences('../outside')).toBeNull();
      expect(listReferencePresets()).toEqual([]);
    });

    test('a library file that is not a preset is refused', async () => {
      writeFileSync(join(PATHS.presets, 'Broken.json'), '"just a string"');
      await expect(copyPresetToReferences('Broken')).rejects.toThrow();
      expect(listReferencePresets()).toEqual([]);
    });

    test('the route copies, and 404s a missing preset', async () => {
      writeFileSync(join(PATHS.presets, 'Mine.json'), raw);
      const post = (presetId: unknown) =>
        handleReferencePresetRoute(
          new Request('http://x/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ presetId }),
          }),
          ['copy'],
        );

      const copied = await post('Mine');
      expect(copied?.status).toBe(201);
      expect(((await copied!.json()) as { id: string }).id).toBe('Mine');

      expect((await post('Nope'))?.status).toBe(404);
      expect((await post(42))?.status).toBe(400);
    });
  });
});
