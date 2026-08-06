/**
 * Reading a card's creator notes as a list of scenarios, one per greeting.
 *
 * The convention this serves is not in the spec and never will be: a card with alternate
 * greetings usually explains them in `creator_notes` as a bare list, one line per greeting,
 * in swipe order. The swiper says "4/10" and the notes say what number four is — but only
 * if you can line them up, and nothing in the card says the two are related.
 *
 * So this guesses, and only commits to the guess when the arithmetic is unambiguous: a run
 * of lines exactly as long as the card's greeting list. Anything else falls back to
 * rendering the notes whole, which is what the reader would have got anyway. A wrong
 * highlight is worse than no highlight, so the bar for claiming a match is "the counts
 * agree", never "close enough".
 *
 * Pure and separate from the popover, like `guides.ts` beside `GuidesPopover` — there is no
 * DOM harness in this project, so the part worth testing has to be reachable without one.
 */

/** Bullets and numbers a hand-written list might carry, stripped for display. */
const MARKER = /^\s*(?:[-*+•]|\(?\d+[.):]|\d+\s+[-–—])\s+/;

/** A line that introduces the list rather than being in it: "Scenarios:", "Greetings —". */
const HEADER = /[:：]\s*$/;

export interface ScenarioNotes {
  /** Notes above the list. Empty when the list starts at the top. */
  intro: string;
  /**
   * One entry per greeting, in swipe order, markers stripped. Empty when no run of lines
   * matched the greeting count — the caller then renders `intro` alone, which in that case
   * holds the untouched notes.
   */
  scenarios: string[];
  /** Notes below the list. */
  outro: string;
}

/**
 * Split `notes` around a scenario list of exactly `greetingCount` entries.
 *
 * `greetingCount` comes from the card, not from the message's swipe count: re-rolling the
 * opening message appends swipes that were never greetings, and those must not shift the
 * list out of alignment.
 */
export function readScenarioNotes(notes: string, greetingCount: number): ScenarioNotes {
  const whole: ScenarioNotes = { intro: notes.trim(), scenarios: [], outro: '' };
  if (greetingCount < 2 || !notes.trim()) return whole;

  const lines = notes.replace(/\r\n?/g, '\n').split('\n');

  for (const run of runs(lines)) {
    // The header sits against the list with no blank line between them far more often than
    // not, so a run one too long is the expected shape, not an oddity.
    const headed = run.length === greetingCount + 1 && HEADER.test(lines[run.start] ?? '');
    if (run.length !== greetingCount && !headed) continue;

    const start = headed ? run.start + 1 : run.start;
    const scenarios = lines.slice(start, run.end).map((line) => line.replace(MARKER, '').trim());
    // A run of blank-ish lines can reach the right length without saying anything.
    if (scenarios.some((scenario) => !scenario)) continue;

    return {
      // Up to `start`, so a header stays with the notes it introduces rather than being
      // dropped for the crime of not being a list entry.
      intro: lines.slice(0, start).join('\n').trim(),
      scenarios,
      outro: lines.slice(run.end).join('\n').trim(),
    };
  }

  return whole;
}

/** Contiguous stretches of non-blank lines, as half-open [start, end) ranges. */
function runs(lines: readonly string[]): { start: number; end: number; length: number }[] {
  const found: { start: number; end: number; length: number }[] = [];
  let start: number | null = null;

  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || !(lines[i] ?? '').trim();
    if (blank) {
      if (start !== null) found.push({ start, end: i, length: i - start });
      start = null;
    } else if (start === null) {
      start = i;
    }
  }

  return found;
}
