/** Number and duration formatting, shared by every tile and chart. */

const decimal = new Intl.NumberFormat();

export function count(value: number): string {
  return decimal.format(Math.round(value));
}

/** Thousands collapse once a hero number would otherwise run past its tile. */
export function compact(value: number): string {
  if (Math.abs(value) < 10_000) return count(value);
  if (Math.abs(value) < 1_000_000) return `${Math.round(value / 100) / 10}k`;
  return `${Math.round(value / 100_000) / 10}m`;
}

/** Minutes as "4h 20m". Under an hour keeps the minutes alone rather than "0h 20m". */
export function duration(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Milliseconds as "7.4s". Sub-second latencies keep a digit rather than reading as "0s". */
export function seconds(ms: number | null): string {
  if (ms === null) return '—';
  return `${Math.round(ms / 100) / 10}s`;
}

export function percent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

export function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function fullDayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function monthYearLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** "14:00" — the dial and the readout must agree, so the hour is formatted in one place. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
