import {
  hexToOklch,
  type Lab,
  paletteGradient,
  type Rgb,
  readablePalette,
  rgbToHex,
  rgbToLab,
} from '@shared/colors/color.ts';
import type {
  DialogueColorOverride,
  DialogueTreatment,
  PaletteTreatment,
  SpeakerPaletteOverride,
} from '@shared/types/settings.ts';

export interface PortraitPalette {
  /** Original portrait colours, never brightened for text. Main colour first. */
  colors: readonly string[];
  candidates: readonly string[];
}

interface Region {
  mass: number;
  weight: number;
  edge: number;
  rgb: Rgb;
  lab: Lab;
}
const distance = (a: Lab, b: Lab) => Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);

function mergeRegion(target: Region, other: Region) {
  const mass = target.mass + other.mass;
  target.rgb = target.rgb.map(
    (n, i) => (n * target.mass + other.rgb[i]! * other.mass) / mass,
  ) as Rgb;
  target.mass = mass;
  target.weight += other.weight;
  target.edge += other.edge;
  target.lab = rgbToLab(target.rgb);
}

/** Spatial weighting is best-effort foreground preference, not subject recognition. */
export function selectAvatarPalette(
  pixels: Uint8ClampedArray,
  width?: number,
  height?: number,
): PortraitPalette | null {
  const spatial =
    width !== undefined && height !== undefined && width * height * 4 === pixels.length;
  const histogram = new Map<number, Region>();
  let total = 0;
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]! / 255;
    if (alpha < 0.125) continue;
    const rgb: Rgb = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
    const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
    let weight = alpha;
    let edge = 0;
    if (spatial) {
      const x = ((offset / 4) % width!) / Math.max(1, width! - 1);
      const y = Math.floor(offset / 4 / width!) / Math.max(1, height! - 1);
      const radius = (x * 2 - 1) ** 2 + ((y - 0.46) * 2) ** 2;
      weight *= 0.25 + Math.exp(-2.5 * radius);
      if (x < 0.14 || x > 0.86 || y < 0.1 || y > 0.9) edge = alpha;
    }
    const region: Region = { mass: alpha, weight, edge, rgb, lab: { l: 0, a: 0, b: 0 } };
    const existing = histogram.get(key);
    if (existing) mergeRegion(existing, region);
    else histogram.set(key, region);
    total += alpha;
  }
  if (!total) return null;

  // Population-first seeds and numeric tie breaks keep the result independent of pixel order.
  const seeds = [...histogram].sort((a, b) => b[1].mass - a[1].mass || a[0] - b[0]);
  const clusters: Region[] = [];
  for (const [, region] of seeds) {
    region.lab = rgbToLab(region.rgb);
    let nearest: Region | undefined;
    let delta = Number.POSITIVE_INFINITY;
    for (const cluster of clusters) {
      const next = distance(region.lab, cluster.lab);
      if (next < delta) {
        delta = next;
        nearest = cluster;
      }
    }
    if (nearest && (delta < 0.065 || clusters.length >= 24)) mergeRegion(nearest, region);
    else clusters.push(region);
  }

  const scored = clusters
    .filter((region) => region.mass >= Math.max(1, total * 0.0125))
    .map((region) => {
      const chroma = Math.hypot(region.lab.a, region.lab.b);
      // Border-connected colour is often scenery. Never exclude skin or any hue family.
      const edgeWeight = Math.max(0.18, 1 - (1.6 * region.edge) / region.mass);
      return { region, score: Math.sqrt(region.weight) * (0.18 + 4 * chroma) * edgeWeight };
    })
    .sort(
      (a, b) => b.score - a.score || rgbToHex(a.region.rgb).localeCompare(rgbToHex(b.region.rgb)),
    );
  const candidates: Region[] = [];
  for (const { region } of scored) {
    if (candidates.every((other) => distance(region.lab, other.lab) >= 0.075))
      candidates.push(region);
    if (candidates.length === 6) break;
  }
  if (!candidates.length) return null;
  const colors: string[] = [];
  for (const region of candidates) {
    const color = rgbToHex(region.rgb);
    const lch = hexToOklch(color)!;
    const distinct = colors.every((other) => {
      const previous = hexToOklch(other)!;
      if (lch.c < 0.025 && previous.c < 0.025) return false;
      const hueDistance = Math.abs(((lch.h - previous.h + 540) % 360) - 180);
      return hueDistance >= 20 || Math.abs(lch.c - previous.c) >= 0.055;
    });
    if (distinct) colors.push(color);
    if (colors.length === 3) break;
  }
  return { colors, candidates: candidates.map((region) => rgbToHex(region.rgb)) };
}

export function portraitSuggestions(portrait: PortraitPalette | null): string[][] {
  return (
    portrait?.colors.map((main) =>
      [main, ...portrait.colors.filter((color) => color !== main)].slice(0, 3),
    ) ?? []
  );
}

export function paletteConfiguration(
  value: DialogueColorOverride | undefined,
): SpeakerPaletteOverride {
  if (typeof value === 'string')
    return { source: 'custom', colors: [value], aura: 'single', dialogue: 'solid' };
  if (value && typeof value === 'object') return value;
  return { source: 'portrait', aura: 'single', dialogue: value === null ? 'off' : 'solid' };
}

export function needsPortrait(value: DialogueColorOverride | undefined): boolean {
  return paletteConfiguration(value).source === 'portrait';
}

export function withPaletteColors(
  value: DialogueColorOverride | undefined,
  colors: string[],
): SpeakerPaletteOverride {
  const config = paletteConfiguration(value);
  return { source: 'custom', colors, aura: config.aura, dialogue: config.dialogue };
}

export function withPaletteTreatment(
  value: DialogueColorOverride | undefined,
  key: 'aura',
  treatment: PaletteTreatment,
): SpeakerPaletteOverride;
export function withPaletteTreatment(
  value: DialogueColorOverride | undefined,
  key: 'dialogue',
  treatment: DialogueTreatment,
): SpeakerPaletteOverride;
export function withPaletteTreatment(
  value: DialogueColorOverride | undefined,
  key: 'aura' | 'dialogue',
  treatment: PaletteTreatment | DialogueTreatment,
): SpeakerPaletteOverride {
  return { ...paletteConfiguration(value), [key]: treatment } as SpeakerPaletteOverride;
}

export interface DialogueColors {
  active: boolean;
  color: string | null;
  gradient: string | null;
}

/** All surfaces resolve the same source and treatments, independently of the speech switch. */
export function resolveSpeakerColors(
  enabled: boolean,
  override: DialogueColorOverride | undefined,
  portrait: PortraitPalette | string | null,
) {
  const config = paletteConfiguration(override);
  const colors =
    config.source === 'custom'
      ? config.colors
      : typeof portrait === 'string'
        ? [portrait]
        : (portrait?.colors ?? []);
  const aura = config.aura === 'gradient' ? colors : colors.slice(0, 1);
  const active = enabled && config.dialogue !== 'off';
  const textPalette = config.dialogue === 'gradient' ? colors : colors.slice(0, 1);
  const dialogueColors =
    active && config.source === 'portrait' && typeof portrait !== 'string'
      ? readablePalette(textPalette)
      : textPalette;
  const dialogue: DialogueColors = {
    active,
    color: active ? (dialogueColors[0] ?? null) : null,
    gradient: active && config.dialogue === 'gradient' ? paletteGradient(dialogueColors) : null,
  };
  const accent =
    (config.source === 'portrait' ? readablePalette(colors.slice(0, 1)) : colors)[0] ?? null;
  return { colors, aura, dialogue, accent };
}
