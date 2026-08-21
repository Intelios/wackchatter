/**
 * Calendar folding.
 *
 * The server sends one histogram of UTC hours, and every calendar question is answered
 * here. That split is deliberate: `send_date` is UTC and so is SQLite's `date()`, so
 * bucketing days server-side would file a 23:30 session under tomorrow, and sending a
 * fixed client offset instead would be wrong on the far side of a daylight-saving change.
 * `new Date(ms)` resolves each instant against the rules in force at that instant, which
 * is the only version of this that is right all year.
 */

import type { HourBucket } from '@shared/types/stats.ts';

export interface DayBucket {
  /** Local midnight, as epoch ms. */
  day: number;
  count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight for the day containing this instant. */
export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Ascending by day, gaps omitted. */
export function foldDays(hours: readonly HourBucket[]): DayBucket[] {
  const totals = new Map<number, number>();
  for (const [hour, count] of hours) {
    const day = startOfDay(hour);
    totals.set(day, (totals.get(day) ?? 0) + count);
  }
  return [...totals.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((left, right) => left.day - right.day);
}

/** 24 counts, indexed by local hour. */
export function foldHourOfDay(hours: readonly HourBucket[]): number[] {
  const buckets = new Array<number>(24).fill(0);
  for (const [hour, count] of hours) {
    const index = new Date(hour).getHours();
    buckets[index] = (buckets[index] ?? 0) + count;
  }
  return buckets;
}

/** Seven counts, **index 0 is Monday** — the order the strip is read in. */
export function foldWeekday(hours: readonly HourBucket[]): number[] {
  const buckets = new Array<number>(7).fill(0);
  for (const [hour, count] of hours) {
    // getDay() is Sunday-first; shift so the week starts where the display starts.
    const index = (new Date(hour).getDay() + 6) % 7;
    buckets[index] = (buckets[index] ?? 0) + count;
  }
  return buckets;
}

/**
 * A contiguous run of days ending today, so the column chart has a real time axis rather
 * than a row of active days pretending to be one. Starts at the first day with activity
 * when that is more recent than the cap, which keeps a young library from rendering as a
 * mostly-empty stretch of nothing.
 */
export function recentDays(
  days: readonly DayBucket[],
  maxDays: number,
  now: number = Date.now(),
): DayBucket[] {
  const today = startOfDay(now);
  const counts = new Map(days.map((entry) => [entry.day, entry.count]));
  const earliest = days[0]?.day;
  const cap = today - (maxDays - 1) * DAY_MS;
  const from = earliest === undefined ? today : Math.max(earliest, cap);

  const filled: DayBucket[] = [];
  // Stepping by calendar day rather than adding DAY_MS: a daylight-saving day is 23 or 25
  // hours long, and fixed-width arithmetic drifts an hour past every change.
  const cursor = new Date(from);
  while (cursor.getTime() <= today) {
    const day = startOfDay(cursor.getTime());
    filled.push({ day, count: counts.get(day) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}

export interface Streaks {
  /** Days up to and including today, or up to yesterday if today is still empty. */
  current: number;
  longest: number;
}

/**
 * Today counting as a break the moment midnight passes would report a streak of zero every
 * morning, so an unbroken run ending yesterday is still current until today ends.
 */
export function streaks(days: readonly DayBucket[], now: number = Date.now()): Streaks {
  const active = days.filter((entry) => entry.count > 0).map((entry) => entry.day);
  if (active.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1];
    const day = active[index];
    if (previous === undefined || day === undefined) continue;
    // Same calendar-day step, for the same daylight-saving reason.
    const expected = new Date(previous);
    expected.setDate(expected.getDate() + 1);
    run = day === startOfDay(expected.getTime()) ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const last = active[active.length - 1];
  const live = last === today || last === startOfDay(yesterday.getTime());

  return { current: live ? run : 0, longest };
}

export function activeDayCount(days: readonly DayBucket[]): number {
  return days.reduce((total, entry) => total + (entry.count > 0 ? 1 : 0), 0);
}

/** The busiest single day, or null when nothing has happened. */
export function busiestDay(days: readonly DayBucket[]): DayBucket | null {
  let best: DayBucket | null = null;
  for (const entry of days) {
    if (entry.count > 0 && (best === null || entry.count > best.count)) best = entry;
  }
  return best;
}
