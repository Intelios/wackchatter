import { describe, expect, test } from 'bun:test';
import { formatTimestamp } from './formatDate.ts';

const now = new Date('2026-08-01T17:30:00Z');

describe('formatTimestamp', () => {
  test('same day shows time only', () => {
    const result = formatTimestamp('2026-08-01T05:04:00Z', now);
    expect(result).not.toBeNull();
    expect(result?.short).not.toContain('2026');
    // A time-only form is short; anything carrying a date would not be.
    expect(result?.short.length).toBeLessThanOrEqual(8);
  });

  test('same year includes the day but not the year', () => {
    const result = formatTimestamp('2026-03-12T14:32:00Z', now);
    expect(result?.short).not.toContain('2026');
    expect(result?.short).toContain('12');
  });

  test('a different year includes the year', () => {
    expect(formatTimestamp('2024-03-12T14:32:00Z', now)?.short).toContain('2024');
  });

  test('the full form is always longer than the short one', () => {
    const result = formatTimestamp('2026-08-01T05:04:00Z', now);
    expect(result!.full.length).toBeGreaterThan(result!.short.length);
  });

  test('the ISO string is passed through for <time dateTime>', () => {
    expect(formatTimestamp('2026-08-01T05:04:00Z', now)?.iso).toBe('2026-08-01T05:04:00Z');
  });

  /**
   * The reason this function returns null instead of throwing: Intl throws a RangeError on
   * an invalid date, and one bad timestamp would blank the entire transcript.
   */
  test('unparseable input returns null rather than throwing', () => {
    expect(formatTimestamp('not a date', now)).toBeNull();
    expect(formatTimestamp('', now)).toBeNull();
    expect(formatTimestamp(undefined, now)).toBeNull();
    expect(formatTimestamp(null, now)).toBeNull();
    expect(formatTimestamp(12345, now)).toBeNull();
    expect(formatTimestamp({}, now)).toBeNull();
  });
});
