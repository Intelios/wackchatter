import { describe, expect, test } from 'bun:test';
import { fitCamera, PAD, screenPoint, VIEW_H, VIEW_W, Z_MAX, Z_MIN } from './camera.ts';

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
    expect(c.z).toBeCloseTo((0.8 * 457) / ((1000 + 2 * PAD.x) * scale));
    expect(c.z).toBeGreaterThan(0.7);
    expect(c.z).toBeLessThan(0.8);
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

describe('screenPoint', () => {
  test('an identity camera maps the viewBox onto the letterboxed element', () => {
    // 1200×700 element: the 1000×700 box is centred with 100px of slack each side.
    const p = screenPoint({ x: 0, y: 0 }, { x: 0, y: 0, z: 1 }, { width: 1200, height: 700 });
    expect(p.x).toBe(100);
    expect(p.y).toBe(0);
  });

  test('a wide pane letterboxes vertically and the centre lands on the element centre', () => {
    const p = screenPoint(
      { x: VIEW_W / 2, y: VIEW_H / 2 },
      { x: 0, y: 0, z: 1 },
      { width: 457, height: 787 },
    );
    expect(p.x).toBe(457 / 2);
    expect(p.y).toBe(787 / 2);
  });

  test('camera transform applies inside the letterbox: pan then zoom', () => {
    const camera = { x: 50, y: -40, z: 2 };
    const p = screenPoint({ x: 300, y: 200 }, camera, { width: 1000, height: 700 });
    expect(p.x).toBe(300 * 2 + 50);
    expect(p.y).toBe(200 * 2 - 40);
  });

  test('is the exact inverse of the drag handler for its own output', () => {
    // The pan code converts client deltas with `scale = min(w/VIEW_W, h/VIEW_H)`;
    // a 1:1 element makes that scale 1, so map and pixel space agree.
    const viewport = { width: VIEW_W, height: VIEW_H };
    const camera = { x: -120, y: 80, z: 1.4 };
    const p = screenPoint({ x: 640, y: 210 }, camera, viewport);
    expect(p.x).toBeCloseTo(640 * 1.4 - 120);
    expect(p.y).toBeCloseTo(210 * 1.4 + 80);
  });
});
