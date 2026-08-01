/**
 * Message timestamps, formatted for a transcript.
 *
 * A pure module so it can be tested without a DOM, following `buildChatMenu`.
 *
 * The formatters are built once at module scope. Constructing an `Intl.DateTimeFormat` is
 * the expensive part — far more than formatting with one — and a transcript renders these
 * once per message, so per-render construction would show up on a long chat.
 *
 * Locale is left undefined so it follows the OS. There is no locale setting in this app,
 * and there should not be one: the operating system already knows.
 */

const TIME_ONLY = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

const SAME_YEAR = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

export interface FormattedTimestamp {
  /** What the bubble shows: the shortest form that is still unambiguous. */
  short: string;
  /** The unabbreviated form, for the `title`. */
  full: string;
  /** The original ISO string, for `<time dateTime>`. */
  iso: string;
}

/**
 * Returns null for anything unparseable rather than throwing.
 *
 * `Intl.DateTimeFormat.format` throws a RangeError on an invalid date, and one bad
 * timestamp anywhere in a chat would take the whole transcript down with it. A message
 * with no readable time is worth far less than a message you cannot see at all.
 */
export function formatTimestamp(value: unknown, now: Date = new Date()): FormattedTimestamp | null {
  if (typeof value !== 'string' || !value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const formatter = sameDay
    ? TIME_ONLY
    : date.getFullYear() === now.getFullYear()
      ? SAME_YEAR
      : WITH_YEAR;

  return { short: formatter.format(date), full: FULL.format(date), iso: value };
}
