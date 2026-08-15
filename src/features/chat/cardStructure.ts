/**
 * Finding a card's own structure inside one of its text fields.
 *
 * Cards are written by hand, in no agreed format. Some use markdown headings, some a bare
 * `Appearance:` on its own line, some the bracketed PList and W++ dialects, and plenty are
 * one undivided paragraph. This module is the part that guesses, kept away from
 * `cardSheet.ts` so the composer never has to know which dialect won — it asks for a split
 * and gets one or `null`.
 *
 * `null` is the normal answer and costs the reader nothing: the composer falls back to the
 * card's own fields, which every card has by definition. That is the whole reason the
 * guessing lives behind a seam. A confident wrong index is the failure worth avoiding, so
 * every detector here is required to find at least TWO of its own kind before it claims a
 * structure — one heading is a false positive, not a shape.
 *
 * The two rules that keep the guessing honest:
 *
 *  - **The 2+ rule counts per style.** One markdown heading and one `Appearance:` line are
 *    two accidents, not a structure. Each detector counts only its own kind.
 *  - **Parts partition the text exactly.** Ranges are contiguous, start at 0 and end at the
 *    field's length, heading lines included. A wrong guess therefore costs a section
 *    boundary in the wrong place; it can never cost a sentence.
 *
 * Groups (PList, W++) land in a later phase; a card written in those dialects reads at the
 * field rung until then, which is the rung that cannot fail.
 */

/** How a field announced its sections. */
export type HeadingStyle = 'markdown' | 'xml' | 'bracket' | 'colon';
export type GroupStyle = 'plist' | 'wpp';
export type SplitStyle = HeadingStyle | GroupStyle;

/** One section's label and the half-open range of the field text it owns. */
export interface SplitPart {
  label: string;
  start: number;
  end: number;
}

export interface FieldSplit {
  style: SplitStyle;
  /**
   * In source order, and an exact partition: the parts' ranges are contiguous, start at 0
   * and end at the field's length. Slicing them all and joining returns the field text
   * unchanged, which is what makes "nothing is ever hidden from the reader" a property of
   * the data rather than a promise about the UI.
   */
  parts: SplitPart[];
}

/**
 * Split a field into its own sections, or `null` when it has none worth showing.
 *
 * `fallbackLabel` names the text above the first heading — the field's own name, since that
 * is what the reader would have seen had nothing been found. It is only used when there is
 * such text; a field that opens on a heading gets no spare chip.
 *
 * Headings are tried before groups: a card carrying both is far more likely to be prose
 * under headings that happens to mention a bracketed list than the reverse.
 */
export function splitCardText(text: string, fallbackLabel: string): FieldSplit | null {
  return findHeadingSections(text, fallbackLabel);
}

/**
 * Rung 1 — the field's own headings.
 *
 * Every style is scanned, then the first one to reach two headings wins, in the order
 * below. The order is confidence, not popularity: `## Appearance` cannot be anything but a
 * heading, whereas a line ending in a colon is a heading only by convention, so a card that
 * somehow offers both is read the unambiguous way.
 */
export function findHeadingSections(text: string, fallbackLabel: string): FieldSplit | null {
  if (!text.trim()) return null;

  const lines = readLines(text);
  for (const { style, find } of DETECTORS) {
    const headings = find(lines);
    if (headings.length < 2) continue;
    return { style, parts: toParts(text, lines, headings, fallbackLabel) };
  }
  return null;
}

/** A line's content, with its offset into the source kept so ranges stay exact. */
interface Line {
  /** Without the newline, and without the carriage return of a CRLF file. */
  text: string;
  start: number;
}

/** One heading, as the line it sits on and the words it offers as a label. */
interface Heading {
  label: string;
  line: number;
}

const DETECTORS: readonly { style: HeadingStyle; find: (lines: Line[]) => Heading[] }[] = [
  { style: 'markdown', find: markdownHeadings },
  { style: 'xml', find: xmlHeadings },
  { style: 'bracket', find: bracketHeadings },
  { style: 'colon', find: colonHeadings },
];

/** Long enough for "Likes & Secret Interests", short enough that a sentence fails. */
const MAX_LABEL_CHARS = 60;
const HAS_LETTER = /\p{L}/u;
const LOWERCASE = /\p{Ll}/u;

function readLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;

  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== '\n') continue;
    const raw = text.slice(start, i);
    lines.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, start });
    start = i + 1;
  }

  return lines;
}

/* --- markdown: `## Appearance` --------------------------------------------------------- */

/**
 * The space after the hashes is the whole guard: it is what separates `## Appearance` from
 * `#slice-of-life`, and tags are far commoner in cards than headings are.
 */
const MARKDOWN = /^(#{1,6})[ \t]+(\S.*)$/;

/**
 * Only one level is a card's headings.
 *
 * A card that opens `# Mirei` and then runs `## Appearance`, `## Backstory` has one title
 * and two headings, not three sections. Taking the shallowest level that repeats reads the
 * title as what it is — the top of the description — and leaves the chips as the sections
 * the author actually drew.
 */
function markdownHeadings(lines: Line[]): Heading[] {
  const found: { level: number; label: string; line: number }[] = [];

  lines.forEach((line, index) => {
    const match = MARKDOWN.exec(line.text.trim());
    if (!match) return;
    const label = tidyLabel((match[2] ?? '').replace(/\s*#+$/, ''));
    if (!usableLabel(label)) return;
    found.push({ level: (match[1] ?? '').length, label, line: index });
  });

  const counts = new Map<number, number>();
  for (const heading of found) counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);

  const repeated = [...counts].filter(([, count]) => count >= 2).map(([level]) => level);
  if (!repeated.length) return [];

  const level = Math.min(...repeated);
  return found.filter((heading) => heading.level === level);
}

/* --- xml: `<appearance>…</appearance>` -------------------------------------------------- */

const XML_OPEN = /^<([A-Za-z][\w-]*)>$/;
const XML_CLOSE = /^<\/([A-Za-z][\w-]*)>$/;
const XML_INLINE = /^<([A-Za-z][\w-]*)>[\s\S]*<\/\1>$/;

/**
 * Only tags that close, and only the outermost ones.
 *
 * Requiring the closing tag is what keeps `<START>` — the example-dialogue marker, which
 * every second card carries and which nothing ever closes — from reading as a section
 * heading. Tracking depth is what keeps a `<hair>` nested inside `<appearance>` from
 * becoming a sibling of it.
 */
function xmlHeadings(lines: Line[]): Heading[] {
  const found: (Heading & { closed: boolean })[] = [];
  const open: string[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.text.trim();

    // A whole element on one line is closed by definition; nested ones are not headings.
    const inline = XML_INLINE.exec(trimmed);
    if (inline) {
      if (!open.length) found.push({ label: tagLabel(inline[1] ?? ''), line: index, closed: true });
      return;
    }

    const opened = XML_OPEN.exec(trimmed);
    if (opened) {
      if (!open.length)
        found.push({ label: tagLabel(opened[1] ?? ''), line: index, closed: false });
      open.push(opened[1] ?? '');
      return;
    }

    const closed = XML_CLOSE.exec(trimmed);
    // A close that does not match what is open is prose that looks like markup, not a close.
    if (!closed || open[open.length - 1] !== closed[1]) return;
    open.pop();
    if (open.length) return;
    const last = found[found.length - 1];
    if (last) last.closed = true;
  });

  return found.filter((heading) => heading.closed && usableLabel(heading.label));
}

/* --- bracket: `[Appearance]` ------------------------------------------------------------ */

const BRACKET = /^\[([^[\]]+)\]$/;

/**
 * The characters that mean this is a PList or W++ line rather than a heading —
 * `[Seraphina's body= "pink hair"]`, `[character("Mika")]`. Those are structure too, but
 * they are rung 2's, and reading them as headings would name a section after a whole
 * attribute list.
 */
const NOT_A_HEADING = /["=(){}:]/;

function bracketHeadings(lines: Line[]): Heading[] {
  const found: Heading[] = [];

  lines.forEach((line, index) => {
    const match = BRACKET.exec(line.text.trim());
    if (!match) return;
    const inner = match[1] ?? '';
    if (NOT_A_HEADING.test(inner)) return;
    const label = tidyLabel(inner);
    if (!usableLabel(label) || wordCount(label) > 6) return;
    found.push({ label, line: index });
  });

  return found;
}

/* --- colon: `Appearance:` --------------------------------------------------------------- */

const COLON = /^(.*?)\s*[:：]$/;

/**
 * Words that start sentences, not headings.
 *
 * This is the guard for the one case the other rules cannot see: a line of prose that
 * happens to end on a colon — "She had one rule:". A heading names a topic, so it opens on
 * the topic; a sentence opens on whoever is doing something. Rejecting "Her Appearance:"
 * along the way costs a chip, which is the direction this is allowed to fail in.
 */
const PROSE_OPENERS: ReadonlySet<string> = new Set([
  'a',
  'all',
  'an',
  'and',
  'as',
  'at',
  'but',
  'for',
  'he',
  'her',
  'here',
  'his',
  'i',
  'if',
  'in',
  'it',
  'its',
  'my',
  'of',
  'on',
  'one',
  'our',
  'she',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'we',
  'what',
  'when',
  'with',
  'you',
  'your',
]);

/**
 * The riskiest detector, and the one every hand-written card in the wild needs.
 *
 * A heading here is only a line that stops at a colon, so the guards do the work: nothing
 * after the colon (which alone excludes the `Name: Mirei` block cards open with, and the
 * `{{user}}: Hello` lines of example dialogue), few enough words to be a topic, no sentence
 * punctuation inside it, not opening on a lowercase letter, not opening on a word that
 * starts sentences, and something underneath it to read.
 */
function colonHeadings(lines: Line[]): Heading[] {
  const found: Heading[] = [];

  lines.forEach((line, index) => {
    // Bolding a heading is as common as not: `**Appearance:**` is the same heading.
    const trimmed = line.text.trim().replace(/^\*+/, '').replace(/\*+$/, '').trim();
    const match = COLON.exec(trimmed);
    if (!match) return;

    const label = tidyLabel(match[1] ?? '');
    if (!usableLabel(label) || wordCount(label) > 5) return;
    if (/[.,;!?"()]/.test(label)) return;
    if (LOWERCASE.test(label[0] ?? '')) return;
    if (PROSE_OPENERS.has((label.split(/\s+/)[0] ?? '').toLowerCase())) return;

    found.push({ label, line: index });
  });

  const filled = withContent(lines, found);

  /*
   * If the card separates its headings with a blank line, hold every heading to that.
   *
   * Cards are consistent about this even when they are consistent about nothing else, and
   * it is the one signal that tells a heading from a colon in the middle of a paragraph —
   * prose does not get a blank line to itself. Applied as a preference rather than a rule,
   * so the compact `Appearance:` / text / `Personality:` format still reads: there the
   * preference finds nothing and the unfiltered list stands.
   */
  const spaced = filled.filter((heading) => !lines[heading.line - 1]?.text.trim());
  return spaced.length >= 2 ? spaced : filled;
}

/** Drop headings with nothing under them — a label alone is a sentence that ended oddly. */
function withContent(lines: Line[], headings: Heading[]): Heading[] {
  return headings.filter((heading, index) => {
    const next = headings[index + 1]?.line ?? lines.length;
    for (let i = heading.line + 1; i < next; i++) {
      if (lines[i]?.text.trim()) return true;
    }
    return false;
  });
}

/* --- shared -------------------------------------------------------------------------- */

/** Each heading owns its own line and everything under it, up to the next one. */
function toParts(
  text: string,
  lines: Line[],
  headings: Heading[],
  fallbackLabel: string,
): SplitPart[] {
  const parts: SplitPart[] = [];
  const first = lines[headings[0]?.line ?? 0]?.start ?? 0;

  // Text above the first heading is a section of its own; whitespace above it is not, and
  // gets absorbed so the partition still starts at 0.
  if (text.slice(0, first).trim()) parts.push({ label: fallbackLabel, start: 0, end: first });

  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    parts.push({
      label: heading.label,
      start: parts.length ? (lines[heading.line]?.start ?? 0) : 0,
      end: next ? (lines[next.line]?.start ?? text.length) : text.length,
    });
  });

  return parts;
}

function tidyLabel(raw: string): string {
  return raw
    .replace(/^[*_\s]+/, '')
    .replace(/[*_\s]+$/, '')
    .replace(/\s+/g, ' ');
}

/** `physical_appearance` reads as a tag; `Physical appearance` reads as a chip. */
function tagLabel(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function usableLabel(label: string): boolean {
  return Boolean(label) && label.length <= MAX_LABEL_CHARS && HAS_LETTER.test(label);
}

function wordCount(label: string): number {
  return label.split(/\s+/).filter(Boolean).length;
}
