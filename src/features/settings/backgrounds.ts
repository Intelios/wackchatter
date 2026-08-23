/**
 * Built-in backgrounds.
 *
 * Bundled as client assets rather than seeded into data/backgrounds, for two reasons:
 * data/ is gitignored so a repo copy could not live there anyway, and a seeded file is
 * deletable with no way to get it back. Vite content-hashes these, so they cache forever.
 */

import cleanBedroomUrl from '../../assets/backgrounds/Clean-Bedroom.png';
import japanClassroomUrl from '../../assets/backgrounds/Japan-Classroom.png';
import japanUniversityUrl from '../../assets/backgrounds/Japan-University.png';
import lakesideVillageUrl from '../../assets/backgrounds/Lakeside-Village.png';
import beachDayUrl from '../../assets/backgrounds/Landscape-Beach-Day.png';
import beachNightUrl from '../../assets/backgrounds/Landscape-Beach-Night.png';
import neonAlleyUrl from '../../assets/backgrounds/Neon-Alley.png';
import redBedroomUrl from '../../assets/backgrounds/Red-Bedroom.png';
import stargazerUrl from '../../assets/backgrounds/Stargazer.png';
import stormyLighthouseUrl from '../../assets/backgrounds/Stormy-Lighthouse.png';
import { backgroundApi } from '../../lib/api.ts';

export interface BuiltinBackground {
  id: string;
  label: string;
  url: string;
}

export const BUILTIN_BACKGROUNDS: readonly BuiltinBackground[] = [
  { id: 'beach-day', label: 'Beach Day', url: beachDayUrl },
  { id: 'beach-night', label: 'Beach Night', url: beachNightUrl },
  { id: 'japan-classroom', label: 'Japan Classroom', url: japanClassroomUrl },
  { id: 'red-bedroom', label: 'Red Bedroom', url: redBedroomUrl },
  { id: 'japan-university', label: 'Japan University', url: japanUniversityUrl },
  { id: 'clean-bedroom', label: 'Clean Bedroom', url: cleanBedroomUrl },
  { id: 'stargazer', label: 'Stargazer', url: stargazerUrl },
  { id: 'stormy-lighthouse', label: 'Stormy Lighthouse', url: stormyLighthouseUrl },
  { id: 'lakeside-village', label: 'Lakeside Village', url: lakesideVillageUrl },
  { id: 'neon-alley', label: 'Neon Alley', url: neonAlleyUrl },
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
