import { describe, expect, test } from 'bun:test';
import type { HourBucket } from '@shared/types/stats.ts';
import {
  activeDayCount,
  busiestDay,
  foldDays,
  foldHourOfDay,
  foldWeekday,
  recentDays,
  startOfDay,
  streaks,
} from './buckets.ts';

/** A UTC-hour bucket, as the server sends them. */
function hour(iso: string, count = 1): HourBucket {
  return [Date.parse(iso), count];
}

function isoDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

describe('folding into local days', () => {
  test('hours in the same local day merge', () => {
    const days = foldDays([hour('2026-08-08T15:00:00Z', 3), hour('2026-08-08T16:00:00Z', 4)]);
    expect(days).toHaveLength(1);
    expect(days[0]?.count).toBe(7);
  });

  test('a late-evening hour lands on the local day, not the UTC one', () => {
    // 23:30 local is tomorrow in UTC anywhere east of Greenwich, and yesterday in UTC
    // anywhere west of it. Either way the session belongs to the day the user lived it.
    const local = new Date(2026, 6, 15, 23, 30, 0);
    const days = foldDays([[local.getTime(), 1]]);
    expect(days).toHaveLength(1);
    expect(isoDay(days[0]!.day)).toBe('2026-07-15');
  });

  test('days come back ascending', () => {
    const days = foldDays([hour('2026-08-10T12:00:00Z'), hour('2026-08-08T12:00:00Z')]);
    expect(days.map((entry) => entry.day)).toEqual(
      [...days.map((e) => e.day)].sort((a, b) => a - b),
    );
  });
});

describe('hour of day', () => {
  test('returns 24 buckets indexed by local hour', () => {
    const local = new Date(2026, 7, 8, 19, 0, 0);
    const hours = foldHourOfDay([[local.getTime(), 5]]);
    expect(hours).toHaveLength(24);
    expect(hours[19]).toBe(5);
    expect(hours.reduce((sum, value) => sum + value, 0)).toBe(5);
  });
});

describe('weekday', () => {
  test('index 0 is Monday', () => {
    // 2026-08-10 is a Monday.
    const monday = new Date(2026, 7, 10, 12, 0, 0);
    const sunday = new Date(2026, 7, 9, 12, 0, 0);
    expect(foldWeekday([[monday.getTime(), 2]])[0]).toBe(2);
    expect(foldWeekday([[sunday.getTime(), 3]])[6]).toBe(3);
  });
});

describe('recentDays', () => {
  test('fills the gaps between active days', () => {
    const now = new Date(2026, 7, 20, 10, 0, 0).getTime();
    const days = foldDays([
      [new Date(2026, 7, 17, 12, 0, 0).getTime(), 5],
      [new Date(2026, 7, 20, 12, 0, 0).getTime(), 2],
    ]);

    const filled = recentDays(days, 84, now);
    expect(filled.map((entry) => entry.count)).toEqual([5, 0, 0, 2]);
    expect(isoDay(filled[0]!.day)).toBe('2026-08-17');
    expect(isoDay(filled[3]!.day)).toBe('2026-08-20');
  });

  test('caps at the window rather than reaching back to the first ever day', () => {
    const now = new Date(2026, 7, 20, 10, 0, 0).getTime();
    const days = foldDays([[new Date(2025, 0, 1, 12, 0, 0).getTime(), 1]]);
    expect(recentDays(days, 7, now)).toHaveLength(7);
  });

  test('an empty library is one column, not a crash', () => {
    const now = new Date(2026, 7, 20, 10, 0, 0).getTime();
    expect(recentDays([], 84, now)).toEqual([{ day: startOfDay(now), count: 0 }]);
  });

  test('crossing a daylight-saving change keeps one column per calendar day', () => {
    // 2026-10-25 is the European autumn change: that local day is 25 hours long, so
    // stepping by a fixed 24h would drift and emit the same date twice.
    const now = new Date(2026, 9, 27, 12, 0, 0).getTime();
    const days = foldDays([[new Date(2026, 9, 23, 12, 0, 0).getTime(), 1]]);
    const filled = recentDays(days, 84, now);

    expect(filled.map((entry) => isoDay(entry.day))).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
    expect(new Set(filled.map((entry) => entry.day)).size).toBe(filled.length);
  });

  test('crossing the spring change does not skip a day either', () => {
    const now = new Date(2026, 2, 31, 12, 0, 0).getTime();
    const days = foldDays([[new Date(2026, 2, 28, 12, 0, 0).getTime(), 1]]);
    const filled = recentDays(days, 84, now);
    expect(filled.map((entry) => isoDay(entry.day))).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ]);
  });
});

describe('streaks', () => {
  const day = (offset: number, count = 1) => {
    const date = new Date(2026, 7, 20, 12, 0, 0);
    date.setDate(date.getDate() + offset);
    return { day: startOfDay(date.getTime()), count };
  };
  const now = new Date(2026, 7, 20, 12, 0, 0).getTime();

  test('counts an unbroken run ending today', () => {
    expect(streaks([day(-2), day(-1), day(0)], now)).toEqual({ current: 3, longest: 3 });
  });

  test('a run ending yesterday is still current', () => {
    // Otherwise the streak reads zero every morning until the first message of the day.
    expect(streaks([day(-2), day(-1)], now).current).toBe(2);
  });

  test('a run ending two days ago has lapsed', () => {
    expect(streaks([day(-3), day(-2)], now)).toEqual({ current: 0, longest: 2 });
  });

  test('the longest run survives a later break', () => {
    expect(streaks([day(-9), day(-8), day(-7), day(-6), day(-1)], now)).toEqual({
      current: 1,
      longest: 4,
    });
  });

  test('empty days are not part of a run', () => {
    expect(streaks([day(-2), day(-1, 0), day(0)], now)).toEqual({ current: 1, longest: 1 });
  });

  test('no activity is no streak', () => {
    expect(streaks([], now)).toEqual({ current: 0, longest: 0 });
  });
});

describe('summaries', () => {
  test('activeDayCount ignores the filled zeros', () => {
    const now = new Date(2026, 7, 20, 10, 0, 0).getTime();
    const filled = recentDays(foldDays([[new Date(2026, 7, 18, 12).getTime(), 4]]), 84, now);
    expect(filled.length).toBeGreaterThan(1);
    expect(activeDayCount(filled)).toBe(1);
  });

  test('busiestDay picks the peak, and null when there is none', () => {
    const days = foldDays([
      [new Date(2026, 7, 18, 12).getTime(), 4],
      [new Date(2026, 7, 19, 12).getTime(), 9],
    ]);
    expect(busiestDay(days)?.count).toBe(9);
    expect(busiestDay([])).toBeNull();
  });
});
