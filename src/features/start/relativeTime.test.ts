import { describe, expect, test } from 'bun:test';
import { relativeTime } from './relativeTime.ts';

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  test('anything under a minute is "just now", including mild clock skew', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW - 59 * SECOND, NOW)).toBe('just now');
    expect(relativeTime(NOW + 30 * SECOND, NOW)).toBe('just now');
  });

  test('a minute is sixtieths of the elapsed seconds', () => {
    // The regression this pins: minutes were computed as seconds / 1000, so a
    // five-minute-old chat read "0m ago" and a five-hour-old one "18m ago".
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 40 * MINUTE, NOW)).toBe('40m ago');
    expect(relativeTime(NOW - 59 * MINUTE - 59 * SECOND, NOW)).toBe('59m ago');
  });

  test('hours, then days', () => {
    expect(relativeTime(NOW - 5 * HOUR, NOW)).toBe('5h ago');
    expect(relativeTime(NOW - 23 * HOUR - 59 * MINUTE, NOW)).toBe('23h ago');
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe('3d ago');
  });

  test('a month and older falls back to a calendar date', () => {
    // The exact rendering is locale-dependent, so pin only that the relative labels
    // stop applying past thirty days.
    const label = relativeTime(NOW - 40 * DAY, NOW);
    expect(label.includes('ago')).toBe(false);
    expect(label.length).toBeGreaterThan(0);
  });
});
