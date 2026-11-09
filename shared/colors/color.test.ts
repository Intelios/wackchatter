import { expect, test } from 'bun:test';
import { hexToOklch, minimumGradientContrast, oklchToHex, readablePalette } from './color.ts';

test('colour math round-trips primaries, neutrals and muted portrait colours', () => {
  for (const hex of [
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#808080',
    '#ffffff',
    '#000000',
    '#124b8e',
    '#c98642',
  ]) {
    expect(oklchToHex(hexToOklch(hex)!)).toBe(hex);
  }
});

test('readable Auto colours lift dark stops independently and leave already readable stops alone', () => {
  const readable = readablePalette(['#124b8e', '#f7c948']);
  expect(readable[1]).toBe('#f7c948');
  expect(minimumGradientContrast(readable)).toBeGreaterThanOrEqual(4.5);
  expect(hexToOklch(readable[0]!)!.l).toBeLessThan(0.85);
});
