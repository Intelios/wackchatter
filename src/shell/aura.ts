/**
 * Aura: the open character's dialogue colour, turned into the two numbers the whole 3.0
 * theme is derived from.
 *
 * The stylesheet builds every colour in OKLCH from a hue (`--h`) and a chroma factor (`--c`,
 * 0–1), so each surface keeps the same lightness whatever the character's colour is. That
 * is what makes any colour safe to theme with: contrast is set by lightness, which never
 * moves, and the character only decides the hue and how vivid it is. A grey character gives
 * a chroma near zero, and the app goes grey with them.
 *
 * Pure, so the conversion is pinned by tests rather than by eye.
 */

export interface Oklch {
  /** Perceived lightness, 0–1. */
  l: number;
  /** Chroma, 0 to roughly 0.37 for sRGB. */
  c: number;
  /** Hue in degrees, 0–360. Meaningless when chroma is ~0. */
  h: number;
}

export interface Aura {
  /** Hue in degrees. */
  hue: number;
  /** How vivid the theme is, 0 (grey) to 1 (fully tinted). */
  chroma: number;
}

/** No colour to go on (dialogue colours off, or not worked out yet): a quiet neutral. */
export const NEUTRAL_AURA: Readonly<Aura> = { hue: 265, chroma: 0.12 };

/**
 * The OKLCH chroma at which the theme is fully tinted. Dialogue colours are lifted for
 * legibility on a dark surface, which keeps most of them between 0.08 and 0.2; anything
 * from here up counts as fully vivid.
 */
const FULL_CHROMA = 0.12;

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let digits = match[1]!;
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** sRGB hex to OKLCH (Björn Ottosson's OKLab, in polar form). Null for anything unparseable. */
export function hexToOklch(hex: string): Oklch | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];

  const lms = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt) as [number, number, number];

  const L = 0.2104542553 * lms[0] + 0.793617785 * lms[1] - 0.0040720468 * lms[2];
  const a = 1.9779984951 * lms[0] - 2.428592205 * lms[1] + 0.4505937099 * lms[2];
  const bb = 0.0259040371 * lms[0] + 0.7827717662 * lms[1] - 0.808675766 * lms[2];

  const c = Math.hypot(a, bb);
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** The aura for a dialogue colour, or the neutral one when there is none to read. */
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
