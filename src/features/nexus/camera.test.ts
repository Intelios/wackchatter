import { describe, expect, test } from 'bun:test';
import { fitCamera, PAD, VIEW_H, VIEW_W, Z_MAX, Z_MIN } from './camera.ts';

describe('fitCamera', () => {
  test('no points resets to the identity camera', () => {
    expect(fitCamera([], { width: 457, height: 787 })).toEqual({ x: 0, y: 0, z: 1 });
  });

  test('a degenerate viewport falls back to the viewBox itself', () => {
    const c = fitCamera([{ x: 500, y: 350 }], { width: 0, height: 0 });
    expect(Number.isFinite(c.x)).toBe(true);
    expect(Number.isFinite(c.y)).toBe(true);
    expect(Number.isFinite(c.z)).toBe(true);
  });

  test('centres the content on the viewBox centre, label skirt included', () => {
    const c = fitCamera(
      [
        { x: 200, y: 100 },
        { x: 600, y: 500 },
      ],
      { width: 1000, height: 700 },
    );
    expect(c.x + 400 * c.z).toBe(VIEW_W / 2);
    const cy = (100 - PAD.top + 500 + PAD.bottom) / 2;
    expect(c.y + cy * c.z).toBe(VIEW_H / 2);
  });

  test('a wide graph on a tall pane is limited by the pane width, not the box height', () => {
    // 457×787 pane, content spanning the full 1000 box width: the old fit aimed
    // at 900×600 of the viewBox and left over half the pane height empty.
    const c = fitCamera(
      [
        { x: 0, y: 300 },
        { x: 1000, y: 400 },
      ],
      { width: 457, height: 787 },
    );
    const scale = Math.min(457 / VIEW_W, 787 / VIEW_H);
    expect(c.z).toBeCloseTo((0.9 * 457) / ((1000 + 2 * PAD.x) * scale));
    expect(c.z).toBeGreaterThan(0.75);
    expect(c.z).toBeLessThan(1);
  });

  test('a tall sparse graph on a tall pane zooms in past the old fit cap of 2', () => {
    const c = fitCamera(
      [
        { x: 450, y: 300 },
        { x: 550, y: 400 },
      ],
      { width: 457, height: 787 },
    );
    expect(c.z).toBe(Z_MAX);
  });

  test('an enormous spread floors at the minimum zoom', () => {
    const c = fitCamera(
      [
        { x: 0, y: 0 },
        { x: 1e6, y: 1e6 },
      ],
      { width: 457, height: 787 },
    );
    expect(c.z).toBe(Z_MIN);
  });
});
