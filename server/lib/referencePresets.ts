/**
 * Reference preset storage. One JSON file per preset in data/reference-presets —
 * SillyTavern-format presets the user collected as examples for the Preset Co-Creator
 * assistant to study. They are deliberately not part of the live preset list.
 *
 * Files are stored verbatim (the downloaded artifact is the thing being referenced);
 * normalizePreset runs on read, never on write. Deletion has no last-one guard — an
 * empty folder is a valid state, unlike the live preset list.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalizePreset } from '../../shared/prompt/preset-io.ts';
import type {
  ReferencePresetRecord,
  ReferencePresetSummary,
} from '../../shared/types/preset-cocreator.ts';
import { withFileLock, withResourceLock } from './fs.ts';
import { PATHS, safeJoin, sanitizeFilename, uniqueName } from './paths.ts';

function referencePath(id: string): string | null {
  return safeJoin(PATHS.referencePresets, `${id}.json`);
}

function versionOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function listReferencePresets(): ReferencePresetSummary[] {
  if (!existsSync(PATHS.referencePresets)) return [];

  return readdirSync(PATHS.referencePresets)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => {
      const id = basename(file, '.json');
      return {
        id,
        name: id,
        modified: statSync(join(PATHS.referencePresets, file)).mtimeMs,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one reference file: the verbatim text plus its normalised view. */
export function getReferencePreset(id: string): ReferencePresetRecord | null {
  const path = referencePath(id);
  if (!path || !existsSync(path)) return null;

  const raw = readFileSync(path, 'utf8');
  let preset: ReferencePresetRecord['preset'];
  try {
    preset = normalizePreset(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Reference preset "${id}" is not a usable preset: ${(error as Error).message}`);
  }
  return {
    id,
    name: id,
    modified: statSync(path).mtimeMs,
    version: versionOf(raw),
    preset,
    raw,
  };
}

/**
 * Store a preset file as a reference, verbatim, under a free name derived from the
 * suggested filename. The text must parse and normalise — anything else is rejected
 * before a name is allocated.
 */
export async function importReferencePreset(
  rawText: string,
  suggestedName: string,
): Promise<ReferencePresetSummary> {
  normalizePreset(JSON.parse(rawText));
  return withResourceLock(`reference-presets:${PATHS.referencePresets}`, async () => {
    const base = sanitizeFilename(suggestedName.replace(/\.json$/i, '')) ?? 'Imported Preset';
    const id = uniqueName(base, referenceExists);
    const path = referencePath(id);
    if (!path) throw new Error(`"${id}" is not a usable reference preset name.`);
    await withFileLock(path, (replace) => replace(rawText));
    return { id, name: id, modified: Date.now() };
  });
}

/** Delete a reference. An empty folder is fine, so there is no last-one guard. */
export function deleteReferencePreset(id: string): Promise<boolean> {
  const path = referencePath(id);
  if (!path) return Promise.resolve(false);
  return withFileLock(path, () => {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  });
}

function referenceExists(name: string): boolean {
  return existsSync(join(PATHS.referencePresets, `${name}.json`));
}
