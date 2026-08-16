import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultPreset } from '../../shared/prompt/defaults.ts';
import { DEFAULT_DATA_DIR, PATHS, setDataDir } from './paths.ts';
import {
  deletePreset,
  duplicatePreset,
  getPreset,
  importPreset,
  listPresets,
  renamePreset,
  savePreset,
} from './presets.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-presets-'));
  setDataDir(dir);
  mkdirSync(PATHS.presets, { recursive: true });
});

afterEach(() => {
  setDataDir(DEFAULT_DATA_DIR);
  rmSync(dir, { recursive: true, force: true });
});

describe('presets', () => {
  test('save and get preset', async () => {
    const preset = createDefaultPreset();
    await savePreset('TestPreset', preset);

    const loaded = getPreset('TestPreset');
    expect(loaded).not.toBeNull();
    expect(loaded?.temperature).toBe(preset.temperature);
  });

  test('list presets', async () => {
    await savePreset('Beta', createDefaultPreset());
    await savePreset('Alpha', createDefaultPreset());

    const list = listPresets();
    expect(list.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
  });

  test('rename preset', async () => {
    await savePreset('OldName', createDefaultPreset());
    const renamed = renamePreset('OldName', 'NewName');

    expect(renamed).toEqual(expect.objectContaining({ id: 'NewName', name: 'NewName' }));
    expect(getPreset('OldName')).toBeNull();
    expect(getPreset('NewName')).not.toBeNull();
  });

  test('duplicate preset from disk', async () => {
    const original = createDefaultPreset();
    original.temperature = 1.25;
    await savePreset('Default', original);

    const duplicated = await duplicatePreset('Default');
    expect(duplicated).not.toBeNull();
    expect(duplicated?.id).toBe('Default (copy)');
    expect(duplicated?.name).toBe('Default (copy)');

    const loadedCopy = getPreset('Default (copy)');
    expect(loadedCopy).not.toBeNull();
    expect(loadedCopy?.temperature).toBe(1.25);

    // Original remains intact
    const loadedOriginal = getPreset('Default');
    expect(loadedOriginal?.temperature).toBe(1.25);
  });

  test('duplicate preset increments name when duplicate name already exists', async () => {
    await savePreset('Default', createDefaultPreset());
    await savePreset('Default (copy)', createDefaultPreset());

    const duplicated = await duplicatePreset('Default');
    expect(duplicated?.id).toBe('Default (copy)1');

    const duplicatedAgain = await duplicatePreset('Default');
    expect(duplicatedAgain?.id).toBe('Default (copy)2');
  });

  test('duplicate preset with in-memory custom draft', async () => {
    const original = createDefaultPreset();
    original.temperature = 0.7;
    await savePreset('Default', original);

    const modifiedDraft = createDefaultPreset();
    modifiedDraft.temperature = 1.8;

    const duplicated = await duplicatePreset('Default', modifiedDraft);
    expect(duplicated?.id).toBe('Default (copy)');

    // The duplicated preset gets the modified draft
    const loadedCopy = getPreset('Default (copy)');
    expect(loadedCopy?.temperature).toBe(1.8);

    // The original file on disk is untouched
    const loadedOriginal = getPreset('Default');
    expect(loadedOriginal?.temperature).toBe(0.7);
  });

  test('duplicate non-existent preset returns null', async () => {
    const duplicated = await duplicatePreset('NonExistent');
    expect(duplicated).toBeNull();
  });

  test('delete preset removes file', async () => {
    await savePreset('ToDelete', createDefaultPreset());
    expect(deletePreset('ToDelete')).toBe(true);
    expect(getPreset('ToDelete')).toBeNull();
    expect(deletePreset('ToDelete')).toBe(false);
  });

  test('import preset saves under sanitized unique name', async () => {
    const imported = await importPreset(createDefaultPreset(), 'My Imported Preset.json');
    expect(imported.id).toBe('My Imported Preset');
    expect(getPreset('My Imported Preset')).not.toBeNull();
  });
});
