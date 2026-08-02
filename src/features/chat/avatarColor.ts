import type { DialogueColorOverride } from '@shared/types/settings.ts';
import { useEffect, useState } from 'react';

interface Hsl {
  h: number;
  s: number;
  l: number;
}

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
}

const CONTRAST_BACKGROUND = '#2b2b2d';
const COLOR_CACHE_LIMIT = 50;
const colorCache = new Map<string, Promise<string | null>>();

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === red) h = ((green - blue) / delta) % 6;
  else if (max === green) h = (blue - red) / delta + 2;
  else h = (red - green) / delta + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = h / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  let rgb: [number, number, number];
  if (section < 1) rgb = [chroma, x, 0];
  else if (section < 2) rgb = [x, chroma, 0];
  else if (section < 3) rgb = [0, chroma, x];
  else if (section < 4) rgb = [0, x, chroma];
  else if (section < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  const match = l - chroma / 2;
  return rgb.map((channel) => Math.round((channel + match) * 255)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const convert = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b);
}

export function contrastRatio(a: string, b: string): number {
  const first = parseHex(a);
  const second = parseHex(b);
  if (!first || !second) return 1;
  const high = Math.max(relativeLuminance(first), relativeLuminance(second));
  const low = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (high + 0.05) / (low + 0.05);
}

function readableColor(hsl: Hsl): string {
  const adjusted: Hsl = { ...hsl, s: Math.max(0.4, hsl.s) };
  if (adjusted.l < 0.5) adjusted.l = 0.65;
  else if (adjusted.l < 0.7) adjusted.l = 0.7;
  else if (adjusted.l > 0.85) adjusted.l = 0.8;

  let hex = toHex(hslToRgb(adjusted));
  while (contrastRatio(hex, CONTRAST_BACKGROUND) < 4.5 && adjusted.l < 0.95) {
    adjusted.l = Math.min(0.95, adjusted.l + 0.02);
    hex = toHex(hslToRgb(adjusted));
  }
  return hex;
}

/** Pure palette choice over RGBA pixels, separated from canvas work for deterministic tests. */
export function selectAvatarColor(pixels: Uint8ClampedArray): string | null {
  const buckets = new Map<number, Bucket>();
  let opaque = 0;

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    const r = pixels[index]!;
    const g = pixels[index + 1]!;
    const b = pixels[index + 2]!;
    opaque += 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }

  if (opaque === 0) return null;
  const minimumPopulation = Math.max(1, Math.ceil(opaque * 0.005));
  let best: { hsl: Hsl; score: number } | null = null;

  for (const bucket of buckets.values()) {
    if (bucket.count < minimumPopulation) continue;
    const hsl = rgbToHsl(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count);
    if (hsl.s < 0.25 || hsl.l < 0.15 || hsl.l > 0.9) continue;
    const lightnessWeight = 1 - Math.min(0.7, Math.abs(hsl.l - 0.55));
    const score = Math.sqrt(bucket.count) * (0.2 + hsl.s) ** 2 * lightnessWeight;
    if (!best || score > best.score) best = { hsl, score };
  }

  return best ? readableColor(best.hsl) : null;
}

async function extractAvatarColor(url: string): Promise<string | null> {
  const image = new Image();
  image.src = url;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Avatar could not be loaded.'));
  });

  const max = 96;
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return selectAvatarColor(context.getImageData(0, 0, canvas.width, canvas.height).data);
}

function cachedAvatarColor(url: string): Promise<string | null> {
  const existing = colorCache.get(url);
  if (existing) return existing;
  const pending = extractAvatarColor(url).catch(() => null);
  colorCache.set(url, pending);
  if (colorCache.size > COLOR_CACHE_LIMIT) colorCache.delete(colorCache.keys().next().value!);
  return pending;
}

export function useAvatarColor(url: string | null): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setColor(null);
    if (url) void cachedAvatarColor(url).then((next) => !cancelled && setColor(next));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return color;
}

export function resolveDialogueColor(
  enabled: boolean,
  override: DialogueColorOverride | undefined,
  avatarColor: string | null,
): { active: boolean; color: string | null } {
  if (!enabled || override === null) return { active: false, color: null };
  return { active: true, color: override ?? avatarColor };
}
