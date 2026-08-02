import { describe, expect, test } from 'bun:test';
import { contrastRatio, resolveDialogueColor, selectAvatarColor } from './avatarColor.ts';

function pixels(colors: Array<{ rgb: [number, number, number]; count: number; alpha?: number }>) {
  const data: number[] = [];
  for (const color of colors) {
    for (let index = 0; index < color.count; index += 1) {
      data.push(...color.rgb, color.alpha ?? 255);
    }
  }
  return new Uint8ClampedArray(data);
}

describe('selectAvatarColor', () => {
  test('prefers a substantial vivid accent over a larger muted region', () => {
    const selected = selectAvatarColor(
      pixels([
        { rgb: [198, 166, 146], count: 80 },
        { rgb: [25, 90, 220], count: 20 },
      ]),
    );

    expect(selected).toMatch(/^#[0-9a-f]{6}$/);
    const blue = Number.parseInt(selected!.slice(5, 7), 16);
    const red = Number.parseInt(selected!.slice(1, 3), 16);
    expect(blue).toBeGreaterThan(red);
  });

  test('ignores transparent pixels and returns null for a grayscale fallback', () => {
    expect(
      selectAvatarColor(
        pixels([
          { rgb: [255, 0, 0], count: 50, alpha: 0 },
          { rgb: [120, 120, 120], count: 50 },
        ]),
      ),
    ).toBeNull();
  });

  test('lifts a dark avatar accent to readable transcript contrast', () => {
    const selected = selectAvatarColor(pixels([{ rgb: [70, 20, 110], count: 100 }]));
    expect(selected).not.toBeNull();
    expect(contrastRatio(selected!, '#2b2b2d')).toBeGreaterThanOrEqual(4.5);
  });

  test('is deterministic for the same pixels', () => {
    const data = pixels([
      { rgb: [30, 180, 120], count: 30 },
      { rgb: [200, 80, 40], count: 20 },
    ]);
    expect(selectAvatarColor(data)).toBe(selectAvatarColor(data));
  });
});

describe('resolveDialogueColor', () => {
  test('global and speaker off both disable colouring', () => {
    expect(resolveDialogueColor(false, '#abcdef', '#123456')).toEqual({
      active: false,
      color: null,
    });
    expect(resolveDialogueColor(true, null, '#123456')).toEqual({ active: false, color: null });
  });

  test('custom wins and missing override uses avatar or token fallback', () => {
    expect(resolveDialogueColor(true, '#abcdef', '#123456')).toEqual({
      active: true,
      color: '#abcdef',
    });
    expect(resolveDialogueColor(true, undefined, '#123456')).toEqual({
      active: true,
      color: '#123456',
    });
    expect(resolveDialogueColor(true, undefined, null)).toEqual({ active: true, color: null });
  });
});
