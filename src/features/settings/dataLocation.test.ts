import { describe, expect, test } from 'bun:test';
import type { LocationInfo, LocationVerdict } from '@shared/types/location.ts';
import { describeCurrent, describeVerdict, formatBytes } from './dataLocation.ts';

const info = (overrides: Partial<LocationInfo> = {}): LocationInfo => ({
  root: '/home/u/data',
  source: 'default',
  envLocked: false,
  defaultRoot: '/home/u/data',
  unreachable: null,
  reason: null,
  warnings: [],
  canBrowse: true,
  needsRestart: null,
  size: null,
  ...overrides,
});

const empty = (
  overrides: Partial<Extract<LocationVerdict, { ok: true }>> = {},
): LocationVerdict => ({
  ok: true,
  kind: 'empty',
  path: '/home/u/elsewhere',
  library: null,
  sameDevice: true,
  warnings: [],
  freeBytes: 1e10,
  ...overrides,
});

describe('formatBytes', () => {
  test('reads like a size, not a number', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(24 * 1024 * 1024)).toBe('24 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});

describe('describeCurrent', () => {
  test('names where the folder came from', () => {
    expect(describeCurrent(info())[0]).toBe('Default folder.');
    expect(describeCurrent(info({ source: 'pointer' }))[0]).toBe('Custom folder.');
    expect(describeCurrent(info({ source: 'env' }))[0]).toBe('Set by WC_DATA_DIR.');
  });

  test('adds the size once it has been measured', () => {
    expect(describeCurrent(info({ size: { bytes: 2048, files: 1 } }))).toEqual([
      'Default folder.',
      '2.0 KB · 1 file',
    ]);
  });
});

describe('describeVerdict', () => {
  test('an empty folder on the same disk says so is instant', () => {
    const described = describeVerdict(empty(), info());
    expect(described.label).toBe('Move here');
    expect(described.tone).toBe('neutral');
    expect(described.disabledReason).toBeNull();
    expect(described.detail).toContain('Same disk, so this is instant.');
  });

  test('a different disk warns about the wait and about the old folder being kept', () => {
    const described = describeVerdict(empty({ sameDevice: false }), info());
    expect(described.detail.join(' ')).toContain('copied');
    expect(described.detail.join(' ')).toContain('old folder is kept');
  });

  test('an existing library is adopted, and its contents are summarised', () => {
    const described = describeVerdict(
      empty({
        kind: 'library',
        library: {
          markerMissing: false,
          characters: 1,
          presets: 2,
          lorebooks: 0,
          hasChats: true,
          modified: null,
        },
      }),
      info(),
    );
    expect(described.label).toBe('Use the library already here');
    // Singular and plural both matter here; the panel says these constantly.
    expect(described.detail[0]).toBe('A WackChatter library: 1 character · 2 presets.');
    expect(described.detail.join(' ')).toContain('Nothing is moved');
  });

  /*
   * Warnings go first and change the verb. "Move here anyway" is the difference between a
   * user who read the warning and a user who clicked past it.
   */
  test('a warning goes on top and the button admits it', () => {
    const described = describeVerdict(
      empty({ warnings: [{ kind: 'cloud', message: 'Inside Dropbox.' }] }),
      info(),
    );
    expect(described.tone).toBe('warn');
    expect(described.label).toBe('Move here anyway');
    expect(described.detail[0]).toBe('Inside Dropbox.');
  });

  test('a refusal explains itself and disables the action', () => {
    const described = describeVerdict(
      {
        ok: false,
        code: 'system-dir',
        message: '/usr belongs to the operating system.',
        path: '/usr',
      },
      info(),
    );
    expect(described.tone).toBe('danger');
    expect(described.disabledReason).toBe('/usr belongs to the operating system.');
  });

  test('the current folder is not an error, just nothing to do', () => {
    const described = describeVerdict(empty({ kind: 'same' }), info());
    expect(described.disabledReason).toBe('Already using this folder.');
  });

  // Every disabled state names its reason — a greyed-out button with no explanation is the
  // thing this is here to prevent.
  test.each([
    ['pinned by the environment', info({ envLocked: true }), {}, /WC_DATA_DIR/],
    ['a move already running', info(), { busy: true }, /Already moving/],
    ['an unsaved preset', info(), { unsavedPreset: true }, /Save or revert/],
    ['a failed switch', info({ needsRestart: 'Restart WackChatter.' }), {}, /Restart/],
  ] as const)('is blocked by %s, with a reason', (_label, current, options, pattern) => {
    const described = describeVerdict(empty(), current, options);
    expect(described.disabledReason).toMatch(pattern);
  });
});
