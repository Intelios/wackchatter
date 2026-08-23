/**
 * Resolve which effect (if any) the current settings ask for. Pure, and the one gate
 * every shell goes through, so the degrade rules cannot disagree between surfaces:
 *
 * - the master switch off, or no background set → nothing;
 * - an unpaired background → nothing (the map ships empty; pairing is user-driven);
 * - a pairing whose id the catalog no longer knows → nothing, the same way a deleted
 *   upload degrades to "no background" rather than a broken image.
 */

import { type EffectId, getEffect } from './effects.ts';

export interface BackgroundEffectSource {
  backgroundEffectEnabled?: boolean;
  background?: string | null;
  /**
   * `unknown` on purpose: this is the defensive boundary against a hand-edited
   * settings file, and the checks below are what make it total.
   */
  backgroundEffects?: unknown;
}

export function resolveBackgroundEffect(source: BackgroundEffectSource): EffectId | null {
  if (source.backgroundEffectEnabled === false) return null;
  const background = source.background;
  if (typeof background !== 'string' || background === '') return null;
  const pairing = source.backgroundEffects;
  if (pairing === null || typeof pairing !== 'object') return null;
  const id = (pairing as Record<string, unknown>)[background];
  if (typeof id !== 'string') return null;
  return getEffect(id)?.id ?? null;
}

/**
 * The pairing map's one write path: set (or clear, with null) one background's effect
 * without touching the others — the UI sends the result as a whole-object patch, and
 * `mergeSettings` guards it, so a clear must mean "this key gone", not "map gone".
 */
export function pairBackgroundEffect(
  map: Record<string, string>,
  background: string,
  id: string | null,
): Record<string, string> {
  const next = { ...map };
  if (id === null) delete next[background];
  else next[background] = id;
  return next;
}
