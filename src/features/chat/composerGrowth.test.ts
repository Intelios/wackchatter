import { describe, expect, test } from 'bun:test';
import {
  type ComposerMaxHeightInput,
  composerMaxHeight,
  MAX_ROWS,
  MAX_VIEWPORT_SHARE,
  rowCap,
} from './composerGrowth.ts';

/** The real box: 15px text at 1.55, 10px padding each side, a 1px border each side. */
const LINE_HEIGHT = 15 * 1.55;
const V_PADDING = 20;
const V_BORDERS = 2;
const ROW_HEIGHT = LINE_HEIGHT + V_PADDING + V_BORDERS;
const CAP = rowCap({
  lineHeight: LINE_HEIGHT,
  verticalPadding: V_PADDING,
  verticalBorders: V_BORDERS,
});

/** The tray: the gap above it (--wc-space-2), its padding, and one --wc-control row. */
const TRAY = 40;

function input(overrides: Partial<ComposerMaxHeightInput> = {}): ComposerMaxHeightInput {
  return {
    rowCap: CAP,
    viewportHeight: 900,
    trayBlock: TRAY,
    rowHeight: ROW_HEIGHT,
    ...overrides,
  };
}

describe('rowCap', () => {
  test('is sixteen line boxes plus the box furniture', () => {
    expect(CAP).toBeCloseTo(LINE_HEIGHT * MAX_ROWS + V_PADDING + V_BORDERS, 5);
  });

  test('an unreadable line height yields no fixed ceiling rather than a wrong one', () => {
    // getComputedStyle can hand back "normal", which parses to NaN. Falling back to a
    // guessed pixel value would pin the input at a height nothing chose; Infinity defers
    // to the viewport ceiling instead, which is always measurable.
    expect(
      rowCap({ lineHeight: Number.NaN, verticalPadding: V_PADDING, verticalBorders: V_BORDERS }),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(rowCap({ lineHeight: 0, verticalPadding: V_PADDING, verticalBorders: V_BORDERS })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('composerMaxHeight', () => {
  test('takes the row cap when the window is tall enough', () => {
    // 1080 * 0.45 = 486, minus the tray is 446 — still above the 16-row cap of ~394.
    expect(composerMaxHeight(input({ viewportHeight: 1080 }))).toBeCloseTo(CAP, 5);
  });

  test('takes the viewport share when the window is short', () => {
    expect(composerMaxHeight(input({ viewportHeight: 700 }))).toBeCloseTo(
      700 * MAX_VIEWPORT_SHARE - TRAY,
      5,
    );
  });

  /**
   * The regression this module exists for.
   *
   * The share is a budget for the COMPOSER. Charging it to the input alone let the composer
   * reach its share plus the tray's height — the ceiling stopped meaning what it says.
   */
  test('the tray comes out of the viewport budget, not on top of it', () => {
    const short = { viewportHeight: 700 };
    const withTray = composerMaxHeight(input({ ...short, trayBlock: TRAY }));
    const withoutTray = composerMaxHeight(input({ ...short, trayBlock: 0 }));

    expect(withoutTray - withTray).toBeCloseTo(TRAY, 5);
    // The whole composer lands inside the share, which is the point.
    expect(withTray + TRAY).toBeCloseTo(700 * MAX_VIEWPORT_SHARE, 5);
  });

  test('a taller tray leaves the input less room, one pixel for one', () => {
    const base = composerMaxHeight(input({ viewportHeight: 800, trayBlock: 40 }));
    const taller = composerMaxHeight(input({ viewportHeight: 800, trayBlock: 60 }));
    expect(base - taller).toBeCloseTo(20, 5);
  });

  test('never computes below a single row, however short the window', () => {
    // 180 * 0.45 = 81, minus a 40px tray is 41 — under one row of 45.25.
    expect(composerMaxHeight(input({ viewportHeight: 180 }))).toBeCloseTo(ROW_HEIGHT, 5);
  });

  test('a tray taller than the whole budget still leaves one row', () => {
    expect(composerMaxHeight(input({ viewportHeight: 700, trayBlock: 9999 }))).toBeCloseTo(
      ROW_HEIGHT,
      5,
    );
  });

  test('a negative tray measurement cannot buy extra height', () => {
    expect(composerMaxHeight(input({ viewportHeight: 700, trayBlock: -200 }))).toBeCloseTo(
      composerMaxHeight(input({ viewportHeight: 700, trayBlock: 0 })),
      5,
    );
  });

  test('an unmeasurable viewport falls back to the fixed ceiling', () => {
    expect(composerMaxHeight(input({ viewportHeight: Number.NaN }))).toBeCloseTo(CAP, 5);
    expect(composerMaxHeight(input({ viewportHeight: 0 }))).toBeCloseTo(CAP, 5);
  });

  test('with neither ceiling measurable it still returns one usable row', () => {
    expect(
      composerMaxHeight(input({ viewportHeight: 0, rowCap: Number.POSITIVE_INFINITY })),
    ).toBeCloseTo(ROW_HEIGHT, 5);
  });
});
