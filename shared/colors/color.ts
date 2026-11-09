/** Pure sRGB / OKLab colour math shared by palette extraction, previews and Aura. */
export type Rgb = [number, number, number];
export interface Lab {
  l: number;
  a: number;
  b: number;
}
export interface Oklch {
  l: number;
  c: number;
  h: number;
}
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export const DIALOGUE_BACKGROUND = '#2b2b2d';

export function hexToRgb(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let digits = match[1]!;
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((n) =>
      Math.round(Math.max(0, Math.min(255, n)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const linear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const gamma = (value: number) =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

export function rgbToLab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map((n) => linear(n / 255)) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function labToRgb({ l, a, b }: Lab): Rgb {
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
  ].map((n) => gamma(n) * 255) as Rgb;
}

export function hexToOklch(hex: string): Oklch | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const { l, a, b } = rgbToLab(rgb);
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** Reduce chroma into sRGB without rotating the hue or clipping individual channels. */
export function oklchToHex({ l, c, h }: Oklch): string {
  const angle = (h * Math.PI) / 180;
  const rgbAt = (chroma: number) =>
    labToRgb({ l, a: chroma * Math.cos(angle), b: chroma * Math.sin(angle) });
  const inGamut = (rgb: Rgb) => rgb.every((n) => n >= -0.01 && n <= 255.01);
  let rgb = rgbAt(c);
  if (!inGamut(rgb)) {
    let low = 0;
    let high = c;
    for (let i = 0; i < 16; i++) {
      const mid = (low + high) / 2;
      if (inGamut(rgbAt(mid))) low = mid;
      else high = mid;
    }
    rgb = rgbAt(low);
  }
  return rgbToHex(rgb);
}

export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const [r, g, blue] = rgb.map((n) => linear(n / 255)) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
  };
  const first = luminance(a);
  const second = luminance(b);
  if (first === null || second === null) return 1;
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Includes the sRGB interpolation inside each segment, just like the CSS gradient. */
export function minimumGradientContrast(
  colors: readonly string[],
  background = DIALOGUE_BACKGROUND,
): number {
  if (!colors.length) return 1;
  let minimum = Math.min(...colors.map((color) => contrastRatio(color, background)));
  for (let index = 1; index < colors.length; index++) {
    const start = hexToRgb(colors[index - 1]!);
    const end = hexToRgb(colors[index]!);
    if (!start || !end) return 1;
    for (let step = 1; step < 32; step++) {
      const t = step / 32;
      const rgb = start.map((n, channel) => n + (end[channel]! - n) * t) as Rgb;
      minimum = Math.min(minimum, contrastRatio(rgbToHex(rgb), background));
    }
  }
  return minimum;
}

/** Only automatic dialogue is lifted; low-chroma portraits never acquire invented colour. */
export function readablePalette(colors: readonly string[]): string[] {
  if (!colors.length) return [];
  const solid = colors.map((color) => {
    if (contrastRatio(color, DIALOGUE_BACKGROUND) >= 4.65) return color;
    const lch = hexToOklch(color)!;
    let low = lch.l;
    let high = 0.98;
    for (let step = 0; step < 14; step++) {
      const mid = (low + high) / 2;
      if (contrastRatio(oklchToHex({ ...lch, l: mid }), DIALOGUE_BACKGROUND) >= 4.65) high = mid;
      else low = mid;
    }
    return oklchToHex({ ...lch, l: high });
  });
  let result = solid;
  const original = solid.map((hex) => hexToOklch(hex)!);
  for (let lift = 0; minimumGradientContrast(result) < 4.5 && lift < 32; lift++) {
    result = original.map((lch) =>
      oklchToHex({ ...lch, l: Math.min(0.98, lch.l + (lift + 1) * 0.015) }),
    );
  }
  return result;
}

export function paletteGradient(colors: readonly string[]): string | null {
  if (new Set(colors).size < 2) return null;
  return `linear-gradient(90deg, ${colors.join(', ')})`;
}
