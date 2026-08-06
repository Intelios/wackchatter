/**
 * Built-in backgrounds.
 *
 * Bundled as client assets rather than seeded into data/backgrounds, for two reasons:
 * data/ is gitignored so a repo copy could not live there anyway, and a seeded file is
 * deletable with no way to get it back. Vite content-hashes these, so they cache forever.
 *
 * Authored here rather than copied from SillyTavern — its images are AGPL assets, and
 * gradients we drew ourselves carry no licence question at all. The User Settings panel
 * offers a one-click import for anyone who wants ST's, straight from their own install.
 */

import auroraUrl from '../../assets/backgrounds/aurora.svg';
import duskUrl from '../../assets/backgrounds/dusk.svg';
import emberUrl from '../../assets/backgrounds/ember.svg';
import forestUrl from '../../assets/backgrounds/forest.svg';
import roseUrl from '../../assets/backgrounds/rose.svg';
import slateUrl from '../../assets/backgrounds/slate.svg';
import tideUrl from '../../assets/backgrounds/tide.svg';
import voidUrl from '../../assets/backgrounds/void.svg';
import { backgroundApi } from '../../lib/api.ts';

export interface BuiltinBackground {
  id: string;
  label: string;
  url: string;
}

export const BUILTIN_BACKGROUNDS: readonly BuiltinBackground[] = [
  { id: 'void', label: 'Void', url: voidUrl },
  { id: 'slate', label: 'Slate', url: slateUrl },
  { id: 'dusk', label: 'Dusk', url: duskUrl },
  { id: 'ember', label: 'Ember', url: emberUrl },
  { id: 'forest', label: 'Forest', url: forestUrl },
  { id: 'tide', label: 'Tide', url: tideUrl },
  { id: 'rose', label: 'Rose', url: roseUrl },
  { id: 'aurora', label: 'Aurora', url: auroraUrl },
];

/**
 * Turn a stored setting into a URL.
 *
 * Returns null for anything unrecognised — a background deleted out from under the
 * setting degrades to "no background" rather than a broken image.
 */
export function resolveBackgroundUrl(value: unknown, version?: number): string | null {
  if (typeof value !== 'string' || !value) return null;

  if (value.startsWith('builtin:')) {
    const id = value.slice('builtin:'.length);
    return BUILTIN_BACKGROUNDS.find((b) => b.id === id)?.url ?? null;
  }

  if (value.startsWith('user:')) {
    const name = value.slice('user:'.length);
    return name ? backgroundApi.url(name, version) : null;
  }

  return null;
}
