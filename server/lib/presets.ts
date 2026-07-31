/**
 * Preset storage. One JSON file per preset in data/presets, written in SillyTavern's
 * exact byte format so files can be copied between the two apps directly.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createDefaultPreset } from '../../shared/prompt/defaults.ts';
import { normalizePreset, serializePreset } from '../../shared/prompt/preset-io.ts';
import type { Preset, PresetSummary } from '../../shared/types/preset.ts';
import { PATHS, safeJoin, sanitizeFilename, uniqueName } from './paths.ts';

const DEFAULT_PRESET_NAME = 'Default';

function presetPath(id: string): string | null {
  return safeJoin(PATHS.presets, `${id}.json`);
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
  const path = presetPath(id);
  if (!path || !existsSync(path)) return null;

  try {
    return normalizePreset(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new Error(`Preset "${id}" could not be read: ${(error as Error).message}`);
  }
}

export async function savePreset(id: string, preset: Preset): Promise<void> {
  const path = presetPath(id);
  if (!path) throw new Error(`"${id}" is not a usable preset name.`);
  await Bun.write(path, serializePreset(preset));
}

export function deletePreset(id: string): boolean {
  const path = presetPath(id);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

function presetExists(name: string): boolean {
  return existsSync(join(PATHS.presets, `${name}.json`));
}

/** Import a preset under a free name derived from the supplied filename. */
export async function importPreset(raw: unknown, suggestedName: string): Promise<PresetSummary> {
  const preset = normalizePreset(raw);
  const base = sanitizeFilename(suggestedName.replace(/\.json$/i, '')) ?? 'Imported Preset';
  const id = uniqueName(base, presetExists);

  await savePreset(id, preset);
  return { id, name: id, modified: Date.now() };
}

/**
 * Make sure at least one preset exists so the app is usable on first run.
 * Seeds from SillyTavern's shipped default when it can be found, otherwise from ours.
 */
export async function ensureDefaultPreset(): Promise<void> {
  if (listPresets().length > 0) return;
  await savePreset(DEFAULT_PRESET_NAME, createDefaultPreset());
}
