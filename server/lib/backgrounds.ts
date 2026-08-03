/**
 * Background image storage. Loose image files in data/backgrounds.
 *
 * Unlike persona avatars, an upload never overwrites in place: a persona has one avatar,
 * but backgrounds are a gallery, and silently replacing one because the filenames matched
 * would destroy an image the user still wanted.
 *
 * Built-in backgrounds are NOT stored here — they ship as bundled client assets, because
 * data/ is gitignored and a seeded copy would be deletable with no way back.
 */

import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { isImageFilename } from './images.ts';
import { PATHS, PROJECT_ROOT, safeJoin, sanitizeFilename, uniqueName } from './paths.ts';

export interface BackgroundSummary {
  name: string;
  size: number;
  /** Epoch millis, used as the cache-buster in the image URL. */
  modified: number;
}

export function listBackgrounds(): BackgroundSummary[] {
  if (!existsSync(PATHS.backgrounds)) return [];
  return readdirSync(PATHS.backgrounds)
    .filter(isImageFilename)
    .map((name) => {
      const stats = statSync(join(PATHS.backgrounds, name));
      return { name, size: stats.size, modified: stats.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function backgroundPath(name: string): string | null {
  if (!isImageFilename(name)) return null;
  return safeJoin(PATHS.backgrounds, name);
}

export async function saveBackground(file: File): Promise<BackgroundSummary> {
  if (!isImageFilename(file.name)) {
    const extension = extname(file.name).toLowerCase();
    throw new Error(`"${extension || file.name}" is not a supported image type.`);
  }

  const extension = extname(file.name).toLowerCase();
  const stem = sanitizeFilename(file.name.slice(0, -extension.length));
  if (!stem) throw new Error('That filename has no usable characters.');

  const name =
    uniqueName(stem, (candidate) =>
      existsSync(join(PATHS.backgrounds, `${candidate}${extension}`)),
    ) + extension;

  const path = backgroundPath(name);
  if (!path) throw new Error('Could not write the background.');

  await Bun.write(path, await file.arrayBuffer());
  const stats = statSync(path);
  return { name, size: stats.size, modified: stats.mtimeMs };
}

export function deleteBackground(name: string): void {
  const path = backgroundPath(name);
  if (!path || !existsSync(path)) throw new Error('Background not found.');
  unlinkSync(path);
}

/**
 * Where a local SillyTavern checkout keeps its shipped backgrounds.
 *
 * Deliberately not a request parameter: a caller-supplied source directory would turn
 * this into "copy any directory the server can read into data/", which buys nothing here.
 * Point it elsewhere with WC_ST_DIR, the same way WC_DATA_DIR works.
 *
 * lib/location.ts *does* take a directory from the client, which is the same policy rather
 * than an exception to it: this reads arbitrary directories into a location that is served
 * over HTTP, where that one writes the user's own library to a folder they named and exposes
 * nothing new. The reasoning is spelled out there; read both before relaxing either.
 */
function sillyTavernBackgroundDir(): string {
  const root = process.env.WC_ST_DIR
    ? resolve(process.env.WC_ST_DIR)
    : resolve(PROJECT_ROOT, '../SillyTavernSource');
  return join(root, 'default', 'content', 'backgrounds');
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
  source: string;
}

/**
 * Copy backgrounds out of a local SillyTavern install.
 *
 * ST's images are AGPL assets. Copying from the user's own install into their own
 * gitignored data/ redistributes nothing — this repo never carries them, and .gitignore
 * makes committing one by accident impossible. Top level only, images only.
 */
export function importFromSillyTavern(): ImportResult {
  const source = sillyTavernBackgroundDir();
  if (!existsSync(source)) {
    throw new Error(
      `No SillyTavern backgrounds found at ${source}. Set WC_ST_DIR to point at your install.`,
    );
  }

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const name of readdirSync(source)) {
    if (!isImageFilename(name)) continue;

    const target = backgroundPath(name);
    // A name that will not survive sanitising is skipped rather than renamed: the user
    // recognises these by filename, and a silent rename makes the gallery unmatchable.
    if (!target) {
      skipped.push(name);
      continue;
    }
    if (existsSync(target)) {
      skipped.push(name);
      continue;
    }

    copyFileSync(join(source, name), target);
    imported.push(name);
  }

  return { imported, skipped, source };
}
