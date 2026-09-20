/**
 * Preset storage. One JSON file per preset in data/presets, written in SillyTavern's
 * exact byte format so files can be copied between the two apps directly.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createDefaultPreset } from '../../shared/prompt/defaults.ts';
import { normalizePreset, serializePreset } from '../../shared/prompt/preset-io.ts';
import type { Preset, PresetSummary } from '../../shared/types/preset.ts';
import { withFileLock, withFileLocks, withResourceLock } from './fs.ts';
import { PATHS, safeJoin, sanitizeFilename, uniqueName } from './paths.ts';

const DEFAULT_PRESET_NAME = 'Default';

function presetPath(id: string): string | null {
  return safeJoin(PATHS.presets, `${id}.json`);
}

function versionOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function presetContentVersion(preset: Preset): string {
  return versionOf(serializePreset(preset));
}

export interface PresetRecord {
  preset: Preset;
  version: string;
}

export interface SavedPreset {
  version: string;
}

export class PresetConflictError extends Error {
  readonly code = 'preset_conflict';
  constructor(readonly currentVersion: string | null) {
    super('The preset changed elsewhere. Review the newer version before overwriting it.');
    this.name = 'PresetConflictError';
  }
}

export function listPresets(): PresetSummary[] {
  if (!existsSync(PATHS.presets)) return [];

  return readdirSync(PATHS.presets)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => {
      const id = basename(file, '.json');
      return {
        id,
        name: id,
        modified: statSync(join(PATHS.presets, file)).mtimeMs,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getPreset(id: string): Preset | null {
  return getPresetRecord(id)?.preset ?? null;
}

/** Read the portable preset and the content hash used for conditional publication. */
export function getPresetRecord(id: string): PresetRecord | null {
  const path = presetPath(id);
  if (!path || !existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf8');
    return { preset: normalizePreset(JSON.parse(raw)), version: versionOf(raw) };
  } catch (error) {
    throw new Error(`Preset "${id}" could not be read: ${(error as Error).message}`);
  }
}

export async function savePreset(id: string, preset: Preset): Promise<void> {
  await savePresetConditional(id, preset, undefined);
}

/**
 * Atomically replace one preset, optionally only when its current content hash matches.
 * `null` means the caller expects a new file; `undefined` is an unconditional internal save.
 */
export async function savePresetConditional(
  id: string,
  preset: Preset,
  expectedVersion: string | null | undefined,
): Promise<SavedPreset> {
  const path = presetPath(id);
  if (!path) throw new Error(`"${id}" is not a usable preset name.`);
  const serialized = serializePreset(preset);
  await withFileLock(path, async (replace) => {
    const currentRaw = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const currentVersion = currentRaw === null ? null : versionOf(currentRaw);
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new PresetConflictError(currentVersion);
    }
    await replace(serialized);
  });
  return { version: versionOf(serialized) };
}

/**
 * Delete a preset. The last one is refused: prompt assembly needs a preset and the
 * default is only re-seeded at boot (`ensureDefaultPreset`), so an empty directory
 * would leave the app unable to generate until a restart.
 */
export function deletePreset(id: string): Promise<boolean> {
  const path = presetPath(id);
  if (!path) return Promise.resolve(false);
  return withResourceLock(`presets:${PATHS.presets}`, () =>
    withFileLock(path, () => {
      if (!existsSync(path)) return false;
      if (listPresets().length <= 1) {
        throw new Error('The last preset cannot be deleted — duplicate or import another first.');
      }
      unlinkSync(path);
      return true;
    }),
  );
}

/**
 * Rename a preset. A file move, because the filename IS the name — the same rule as
 * lorebooks. Nothing else stores a preset id: `AppSettings` does not, and a card cannot
 * reference one, so unlike a lorebook rename there are no back-references to repoint.
 */
export function renamePreset(id: string, nextName: string): Promise<PresetSummary | null> {
  const from = presetPath(id);
  if (!from) return Promise.resolve(null);

  const base = sanitizeFilename(nextName.replace(/\.json$/i, ''));
  if (!base) throw new Error(`"${nextName}" is not a usable preset name.`);
  const to = presetPath(base);
  if (!to) throw new Error(`"${nextName}" is not a usable preset name.`);
  return withResourceLock(`presets:${PATHS.presets}`, () =>
    withFileLocks([from, to], () => {
      if (!existsSync(from)) return null;
      if (base === id) return { id, name: id, modified: statSync(from).mtimeMs };
      if (presetExists(base)) throw new Error(`A preset called "${base}" already exists.`);
      renameSync(from, to);
      return { id: base, name: base, modified: statSync(to).mtimeMs };
    }),
  );
}

function presetExists(name: string): boolean {
  return existsSync(join(PATHS.presets, `${name}.json`));
}

/** Duplicate a preset. Creates a new JSON file under a free name derived from the original. */
export async function duplicatePreset(
  id: string,
  customPreset?: Preset,
): Promise<PresetSummary | null> {
  const preset = customPreset ? normalizePreset(customPreset) : getPreset(id);
  if (!preset) return null;

  return withResourceLock(`presets:${PATHS.presets}`, async () => {
    const base = sanitizeFilename(`${id} (copy)`) ?? 'Preset (copy)';
    const newId = uniqueName(base, presetExists);
    await savePresetConditional(newId, preset, null);
    return { id: newId, name: newId, modified: Date.now() };
  });
}

/** Import a preset under a free name derived from the supplied filename. */
export async function importPreset(raw: unknown, suggestedName: string): Promise<PresetSummary> {
  const preset = normalizePreset(raw);
  return withResourceLock(`presets:${PATHS.presets}`, async () => {
    const base = sanitizeFilename(suggestedName.replace(/\.json$/i, '')) ?? 'Imported Preset';
    const id = uniqueName(base, presetExists);
    await savePresetConditional(id, preset, null);
    return { id, name: id, modified: Date.now() };
  });
}

/**
 * Make sure at least one preset exists so the app is usable on first run.
 * Seeds from SillyTavern's shipped default when it can be found, otherwise from ours.
 */
export async function ensureDefaultPreset(): Promise<void> {
  if (listPresets().length > 0) return;
  await savePreset(DEFAULT_PRESET_NAME, createDefaultPreset());
}
