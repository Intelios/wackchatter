/**
 * The home screen's words, as pure functions so the rules are pinned by tests.
 *
 * Home is a cover: the last chat's character as the headline, a cover line (the chat's own
 * name, or when you left it, in words), and their last reply as the pull-quote. `now` is
 * injectable everywhere a clock is read.
 */

/** How many other chats the stack lists beside the cover. */
export const STACK_SIZE = 12;

/** The pull-quote's length before it is cut with an ellipsis. */
export const QUOTE_MAX = 150;

/** The title a chat gets when nobody names it (server/lib/chats.ts). */
const DEFAULT_TITLE = 'New chat';

/** Whether a person named this chat, so its title is worth a cover line. */
export function isNamedChat(title: string): boolean {
  const trimmed = title.trim();
  return trimmed !== '' && trimmed !== DEFAULT_TITLE;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NUMBERS = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
];

function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function startOfDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Whole calendar days between two moments, in local time. */
function calendarDays(then: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
}

/**
 * When you left, the way a person says it: "This afternoon", "Late last night",
 * "Monday evening", "A fortnight ago". The cover line for a chat nobody named.
 *
 * Night runs past midnight: anything from 9pm to 5am belongs to the evening it started in,
 * so a chat left at 1am reads "Late last night" the next morning, not "This night".
 */
export function whenInWords(then: number, now: number = Date.now()): string {
  if (now - then < 45 * 60_000) return 'Just now';
  const hour = new Date(then).getHours();
  const small = hour < 5;
  // The small hours count as the night before.
  const days = calendarDays(then, now) + (small ? 1 : 0);
  const part = partOfDay(hour);

  if (days <= 0) return part === 'night' ? 'Tonight' : `This ${part}`;
  if (days === 1) return part === 'night' ? 'Late last night' : `Yesterday ${part}`;
  if (days < 7) {
    const day = new Date(then - (small ? 86_400_000 : 0)).getDay();
    return `${WEEKDAYS[day]} ${part}`;
  }
  if (days < 14) return `Last ${WEEKDAYS[new Date(then).getDay()]}`;
  if (days < 21) return 'A fortnight ago';
  if (days < 28) return 'Three weeks ago';
  const months = Math.floor(days / 30.44);
  if (months < 2) return 'Last month';
  if (months < 12) return `${NUMBERS[months]} months ago`;
  const years = Math.floor(days / 365.25);
  return years < 2 ? 'Last year' : `${NUMBERS[years] ?? years} years ago`;
}

/** The exact time, for hovering a name in the stack: "2 hours ago", "Yesterday". */
export function agoInWords(then: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  const days = calendarDays(then, now);
  if (days === 0) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return months <= 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(days / 365.25);
  return years <= 1 ? '1 year ago' : `${years} years ago`;
}

/**
 * The pull-quote: the first thing the character says aloud in their last reply, taken from
 * inside its quotation marks and cut at a word with "…". Narration, stage directions and
 * out-of-character labels like "[Scene]:" are never quoted, so a reply with no spoken line
 * has no quote at all. Speech inside an *action* does not count either.
 *
 * `{{char}}` and `{{user}}` read as names; any other macro is dropped rather than shown raw.
 */
export function quoteOf(
  text: string,
  names: { char: string; user: string },
  max: number = QUOTE_MAX,
): string {
  const named = text
    .replace(/\{\{char\}\}/gi, names.char)
    .replace(/\{\{user\}\}/gi, names.user)
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\*[^*\n]*\*/g, ' ');
  const spoken = /"([^"\n]+)"|\u201c([^\u201d\n]+)\u201d|«([^»\n]+)»/.exec(named);
  const line = (spoken?.[1] ?? spoken?.[2] ?? spoken?.[3] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(line)) return '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?…-]+$/, '')}…`;
}

/**
 * A long name with spaces, broken into two lines of about equal length, so the headline can
 * stay large. Short names, and names without a space, stay on one line.
 */
export function splitName(name: string): string[] {
  const words = name.trim().split(/\s+/);
  if (name.length <= 12 || words.length < 2) return [name.trim()];
  let best = 1;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** The next index when walking the stack with the arrow keys; -1 is the cover itself. */
export function stepStack(current: number, length: number, direction: 1 | -1): number {
  return Math.max(-1, Math.min(length - 1, current + direction));
}
