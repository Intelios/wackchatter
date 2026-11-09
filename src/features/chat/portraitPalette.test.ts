import { describe, expect, test } from 'bun:test';
import {
  contrastRatio,
  hexToOklch,
  hexToRgb,
  minimumGradientContrast,
  readablePalette,
} from '@shared/colors/color.ts';
import {
  paletteConfiguration,
  portraitSuggestions,
  resolveSpeakerColors,
  selectAvatarPalette,
  withPaletteColors,
  withPaletteTreatment,
} from './portraitPalette.ts';

function pixels(regions: Array<{ rgb: [number, number, number]; count: number; alpha?: number }>) {
  return new Uint8ClampedArray(
    regions.flatMap(({ rgb, count, alpha = 255 }) =>
      Array.from({ length: count }, () => [...rgb, alpha]).flat(),
    ),
  );
}
const portrait = { colors: ['#124b8e', '#c98642'], candidates: ['#124b8e', '#c98642', '#628a86'] };

describe('portrait palette extraction', () => {
  test('groups neighbouring shades instead of letting a single quantisation bucket win', () => {
    const result = selectAvatarPalette(
      pixels([
        { rgb: [30, 90, 170], count: 30 },
        { rgb: [35, 95, 175], count: 30 },
        { rgb: [40, 100, 180], count: 30 },
        { rgb: [190, 125, 65], count: 35 },
      ]),
    )!;
    expect(hexToRgb(result.colors[0]!)![2]).toBeGreaterThan(hexToRgb(result.colors[0]!)![0]);
    expect(result.colors.length).toBe(2);
  });

  test('prefers the central character over an extensive colourful border', () => {
    const side = 40;
    const data = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const center = x >= 11 && x < 29 && y >= 8 && y < 34;
        data.set(center ? [25, 75, 140, 255] : [225, 65, 130, 255], (y * side + x) * 4);
      }
    const result = selectAvatarPalette(data, side, side)!;
    const rgb = hexToRgb(result.colors[0]!)!;
    expect(rgb[2]).toBeGreaterThan(rgb[0]);
    expect(result.colors).toHaveLength(2);
  });

  test('rejects tiny vivid details and transparent colour noise', () => {
    const result = selectAvatarPalette(
      pixels([
        { rgb: [75, 95, 105], count: 995 },
        { rgb: [255, 0, 30], count: 2 },
        { rgb: [20, 255, 30], count: 200, alpha: 0 },
      ]),
    )!;
    expect(result.colors).toEqual(['#4b5f69']);
  });

  test('keeps grayscale and subdued colours, with no invented supporting stops', () => {
    const gray = selectAvatarPalette(pixels([{ rgb: [100, 100, 100], count: 100 }]))!;
    expect(gray.colors).toEqual(['#646464']);
    expect(portraitSuggestions(gray)).toEqual([['#646464']]);
    const muted = selectAvatarPalette(pixels([{ rgb: [100, 110, 115], count: 100 }]))!;
    expect(hexToOklch(muted.colors[0]!)!.c).toBeLessThan(0.025);
    expect(hexToOklch(readablePalette(gray.colors)[0]!)!.c).toBeLessThan(0.0001);
  });

  test('is deterministic, ignores empty images, and retains the original dark accent', () => {
    const data = pixels([{ rgb: [30, 60, 110], count: 100 }]);
    expect(selectAvatarPalette(data)).toEqual(selectAvatarPalette(data));
    expect(selectAvatarPalette(data)!.colors).toEqual(['#1e3c6e']);
    expect(selectAvatarPalette(new Uint8ClampedArray())).toBeNull();
    expect(selectAvatarPalette(pixels([{ rgb: [255, 0, 0], count: 100, alpha: 0 }]))).toBeNull();
  });
});

describe('speaker colours', () => {
  test('Auto defaults to single Aura and readable solid speech from the same raw palette', () => {
    const result = resolveSpeakerColors(true, undefined, portrait);
    expect(result.aura).toEqual(['#124b8e']);
    expect(result.colors).toEqual(portrait.colors);
    expect(result.dialogue.gradient).toBeNull();
    expect(contrastRatio(result.dialogue.color!, '#2b2b2d')).toBeGreaterThanOrEqual(4.5);
  });

  test('treatment changes do not pin an automatic palette', () => {
    const override = withPaletteTreatment(undefined, 'aura', 'gradient');
    expect(override).toEqual({ source: 'portrait', aura: 'gradient', dialogue: 'solid' });
    expect(resolveSpeakerColors(true, override, portrait).aura).toEqual(portrait.colors);
    const changed = { ...portrait, colors: ['#884422', '#227788'] };
    expect(resolveSpeakerColors(true, override, changed).aura).toEqual(changed.colors);
  });

  test('suggestions and manual colours pin exactly, independently of portrait replacement', () => {
    const override = withPaletteColors(undefined, ['#123456', '#abcdef']);
    const gradient = withPaletteTreatment(override, 'dialogue', 'gradient');
    const result = resolveSpeakerColors(true, gradient, null);
    expect(result.dialogue.color).toBe('#123456');
    expect(result.dialogue.gradient).toBe('linear-gradient(90deg, #123456, #abcdef)');
    expect(result.aura).toEqual(['#123456']);
    expect(paletteConfiguration('#123456').source).toBe('custom');
  });

  test('dialogue switches never disable Aura and insufficient colours fall back to solid', () => {
    const override = { source: 'portrait', aura: 'gradient', dialogue: 'gradient' } as const;
    expect(resolveSpeakerColors(false, override, portrait).aura).toEqual(portrait.colors);
    expect(resolveSpeakerColors(false, override, portrait).dialogue).toEqual({
      active: false,
      color: null,
      gradient: null,
    });
    expect(resolveSpeakerColors(true, null, portrait).aura).toEqual(['#124b8e']);
    const single = resolveSpeakerColors(true, override, {
      colors: ['#888888'],
      candidates: ['#888888'],
    });
    expect(single.dialogue.gradient).toBeNull();
    expect(single.aura).toEqual(['#888888']);
  });

  test('automatic gradient interiors are readable and custom interiors can raise a warning', () => {
    const colors = ['#e18a24', '#a78bfa', '#51a0de'];
    expect(minimumGradientContrast(readablePalette(colors))).toBeGreaterThanOrEqual(4.5);
    // Both endpoints pass; their sRGB midpoint is darker and fails.
    const crossing = ['#ff6b6b', '#46a758'];
    expect(crossing.every((color) => contrastRatio(color, '#2b2b2d') >= 4.5)).toBeTrue();
    expect(minimumGradientContrast(crossing)).toBeLessThan(4.5);
    expect(minimumGradientContrast(readablePalette(crossing))).toBeGreaterThanOrEqual(4.5);
  });
});
