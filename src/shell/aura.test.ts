import { describe, expect, test } from 'bun:test';
import { auraFromColor, auraPalette, hexToOklch, NEUTRAL_AURA, nearestHue } from './aura.ts';
import { initialAuraStyle } from './useAura.ts';

test('single Aura keeps its offsets while gradients use original supporting colours', () => {
  const primary = auraFromColor('#124b8e');
  expect(auraPalette(['#124b8e'])).toEqual([
    primary,
    { ...primary, hue: primary.hue + 34 },
    { ...primary, hue: primary.hue - 28 },
  ]);
  expect(auraPalette(['#124b8e', '#c98642'])).toEqual([primary, auraFromColor('#c98642'), primary]);
  expect(auraPalette(['#124b8e', '#c98642', '#628a86'])[2]).toEqual(auraFromColor('#628a86'));
  const style = initialAuraStyle(['#124b8e', '#c98642'], ['#628a86', '#124b8e']);
  expect(style['--w3-c2']).toBe(String(auraFromColor('#c98642').chroma));
  expect(style['--w3-pc2']).toBe(String(primary.chroma));
  expect(auraPalette(['#808080'])[0].chroma).toBe(0);
});

describe('hexToOklch', () => {
  test('matches published OKLCH values for the primaries', () => {
    const red = hexToOklch('#ff0000')!;
    expect(red.l).toBeCloseTo(0.628, 3);
    expect(red.c).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);

    const blue = hexToOklch('#0000ff')!;
    expect(blue.l).toBeCloseTo(0.452, 3);
    expect(blue.h).toBeCloseTo(264.05, 1);
  });

  test('white and grey have no chroma', () => {
    expect(hexToOklch('#ffffff')!.l).toBeCloseTo(1, 4);
    expect(hexToOklch('#ffffff')!.c).toBeLessThan(0.0001);
    expect(hexToOklch('#808080')!.c).toBeLessThan(0.0001);
  });

  test('reads three-digit hex and ignores case', () => {
    expect(hexToOklch('#F00')).toEqual(hexToOklch('#ff0000'));
  });

  test('refuses what is not a hex colour', () => {
    expect(hexToOklch('red')).toBeNull();
    expect(hexToOklch('#12345')).toBeNull();
    expect(hexToOklch('')).toBeNull();
  });
});

describe('auraFromColor', () => {
  test('a vivid colour gives its hue at full strength', () => {
    const aura = auraFromColor('#ff6fae');
    expect(aura.chroma).toBe(1);
    expect(aura.hue).toBeGreaterThan(340);
  });

  test('a grey colour turns the theme grey', () => {
    expect(auraFromColor('#9a9a9a').chroma).toBe(0);
  });

  test('a muted colour gives a partial strength', () => {
    const aura = auraFromColor('#a99db8');
    expect(aura.chroma).toBeGreaterThan(0.1);
    expect(aura.chroma).toBeLessThan(0.6);
  });

  test('no colour, or a broken one, falls back to the neutral aura', () => {
    expect(auraFromColor(null)).toEqual({ ...NEUTRAL_AURA });
    expect(auraFromColor(undefined)).toEqual({ ...NEUTRAL_AURA });
    expect(auraFromColor('nonsense')).toEqual({ ...NEUTRAL_AURA });
  });
});

describe('nearestHue', () => {
  test('takes the short way round', () => {
    expect(nearestHue(350, 10)).toBe(370);
    expect(nearestHue(10, 350)).toBe(-10);
    expect(nearestHue(370, 20)).toBe(380);
  });

  test('leaves a plain step alone', () => {
    expect(nearestHue(100, 200)).toBe(200);
    expect(nearestHue(200, 100)).toBe(100);
  });
});
