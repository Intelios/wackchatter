/**
 * Aura: original speaker colours turned into the hue/chroma pairs used by the 3.0 theme.
 * The primary themes the interface; supporting colours belong to the ambient pools.
 *
 * The stylesheet builds every colour in OKLCH from a hue (`--h`) and a chroma factor (`--c`,
 * 0–1), so each surface keeps the same lightness whatever the character's colour is. That
 * is what makes any colour safe to theme with: contrast is set by lightness, which never
 * moves, and the character only decides the hue and how vivid it is. A grey character gives
 * a chroma near zero, and the app goes grey with them.
 *
 * Pure, so the conversion is pinned by tests rather than by eye.
 */

import { hexToOklch } from '@shared/colors/color.ts';

export { hexToOklch, type Oklch } from '@shared/colors/color.ts';

export type AuraInput = string | readonly string[] | null;

export interface Aura {
  /** Hue in degrees. */
  hue: number;
  /** How vivid the theme is, 0 (grey) to 1 (fully tinted). */
  chroma: number;
}

/** No portrait or pinned colour available: a quiet neutral. */
export const NEUTRAL_AURA: Readonly<Aura> = { hue: 265, chroma: 0.12 };

/**
 * The OKLCH chroma at which the theme is fully tinted. Aura receives the original
 * portrait palette, independently of any lightness adjustment made for speech.
 */
const FULL_CHROMA = 0.12;

/** Aura from an original palette colour, or the neutral one when none is available. */
export function auraFromColor(hex: string | null | undefined): Aura {
  if (!hex) return { ...NEUTRAL_AURA };
  const lch = hexToOklch(hex);
  if (!lch) return { ...NEUTRAL_AURA };
  const chroma = Math.min(1, lch.c / FULL_CHROMA);
  return { hue: Math.round(lch.h * 10) / 10, chroma: Math.round(chroma * 1000) / 1000 };
}

/**
 * The equivalent of `to` closest to `from`, unwrapped past 0/360.
 *
 * The hue animates as a plain number, so going from 350 to 10 the long way would sweep the
 * whole wheel. Handing the stylesheet 370 instead makes it a 20-degree step; OKLCH reads
 * any angle, so the value never needs wrapping back.
 */
export function nearestHue(from: number, to: number): number {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return from + delta;
}

/** Single-colour retains its gentle hue offsets; gradients use actual supporting colours. */
export function auraPalette(input: AuraInput): [Aura, Aura, Aura] {
  const colors = typeof input === 'string' ? [input] : (input ?? []);
  const primary = auraFromColor(colors[0]);
  if (colors.length < 2)
    return [primary, { ...primary, hue: primary.hue + 34 }, { ...primary, hue: primary.hue - 28 }];
  return [primary, auraFromColor(colors[1]), auraFromColor(colors[2] ?? colors[0])];
}
