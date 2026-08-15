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
  return findHeadingSections(text, fallbackLabel) ?? findGroupSections(text, fallbackLabel);
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
  for (const { style, find } of HEADING_DETECTORS) {
    const headings = find(lines);
    if (headings.length < 2) continue;
    return { style, parts: headingParts(text, lines, headings, fallbackLabel) };
  }
  return null;
}

/**
 * Rung 2 — the bracketed dialects.
 *
 * PList (`[Seraphina's body= "pink hair", "amber eyes"]`) and W++ (`Body("pink hair")`) write
 * a character as attribute lines rather than as prose. Each line is a whole attribute, which
 * is the difference from a heading and the reason the ranges are built differently: a
 * heading introduces what comes after it, whereas a group line *is* its own content.
 *
 * Only a contiguous run counts. Cards in these dialects put their attributes together at the
 * top, and the thing that follows is usually example dialogue with a stray bracketed line
 * somewhere in it — so a detector that took every match would hand the last attribute a
 * kilobyte of transcript and add a chip for the stray. The run is what keeps the attributes
 * to themselves; everything after it becomes one section under the field's own name.
 */
export function findGroupSections(text: string, fallbackLabel: string): FieldSplit | null {
  if (!text.trim()) return null;

  const lines = readLines(text);
  for (const { style, find } of GROUP_DETECTORS) {
    const run = contiguousRun(lines, find(lines));
    // Two is a list; forty is a card that writes every sentence in brackets, and turning it
    // into forty chips would be worse than the one section it already reads as.
    if (run.length < 2 || run.length > MAX_GROUPS) continue;
    return { style, parts: groupParts(text, lines, run, fallbackLabel) };
  }
  return null;
}

/** A line's content, with its offset into the source kept so ranges stay exact. */
interface Line {
  /** Without the newline, and without the carriage return of a CRLF file. */
  text: string;
  start: number;
}

/** One section marker, as the line it sits on and the words it offers as a label. */
interface Marker {
  label: string;
  line: number;
}

const HEADING_DETECTORS: readonly { style: HeadingStyle; find: (lines: Line[]) => Marker[] }[] = [
  { style: 'markdown', find: markdownHeadings },
  { style: 'xml', find: xmlHeadings },
  { style: 'bracket', find: bracketHeadings },
  { style: 'colon', find: colonHeadings },
];

const GROUP_DETECTORS: readonly { style: GroupStyle; find: (lines: Line[]) => Marker[] }[] = [
  { style: 'plist', find: plistGroups },
  { style: 'wpp', find: wppGroups },
];

/** Long enough for "Likes & Secret Interests", short enough that a sentence fails. */
const MAX_LABEL_CHARS = 60;
const MAX_GROUPS = 30;
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
function markdownHeadings(lines: Line[]): Marker[] {
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
function xmlHeadings(lines: Line[]): Marker[] {
  const found: (Marker & { closed: boolean })[] = [];
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

function bracketHeadings(lines: Line[]): Marker[] {
  const found: Marker[] = [];

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
function colonHeadings(lines: Line[]): Marker[] {
  const found: Marker[] = [];

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
function withContent(lines: Line[], headings: Marker[]): Marker[] {
  return headings.filter((heading, index) => {
    const next = headings[index + 1]?.line ?? lines.length;
    for (let i = heading.line + 1; i < next; i++) {
      if (lines[i]?.text.trim()) return true;
    }
    return false;
  });
}

/* --- PList: `[Seraphina's body= "pink hair", "amber eyes"]` ----------------------------- */

/**
 * A whole line in brackets, holding a label and then values.
 *
 * The label stops at the first `=` or `:`, and may not contain a bracket of its own, which
 * is what keeps a W++ line — where the first thing after the name is a parenthesis — out of
 * this detector and in its own.
 */
const PLIST = /^\[\s*([^[\]=:]+?)\s*[=:]\s*(\S[\s\S]*?)\s*\]$/;

function plistGroups(lines: Line[]): Marker[] {
  const found: Marker[] = [];

  lines.forEach((line, index) => {
    const match = PLIST.exec(line.text.trim());
    if (!match) return;
    const label = plistLabel(match[1] ?? '');
    if (!usableLabel(label) || wordCount(label) > 5) return;
    found.push({ label, line: index });
  });

  return found;
}

/**
 * `Seraphina's body` is the card telling itself whose body it is; the chip already sits
 * under her avatar, so the possessive is noise. Dropped only when something survives it.
 */
function plistLabel(raw: string): string {
  const owned = /^.*?['’]s\s+(\S[\s\S]*)$/.exec(raw);
  return tagLabel(tidyLabel(owned?.[1] ?? raw));
}

/* --- W++: `Body("pink hair" + "amber eyes")` -------------------------------------------- */

/**
 * One bare word, then its values in parentheses, then the end of the line.
 *
 * The word may not contain a space, which is the guard that matters: `She smiled ("softly")`
 * is prose, and a detector that allowed `She smiled` as an attribute name would find
 * attributes in any narration that used a parenthetical. The `[character("Mika")` header the
 * dialect opens with is excluded by the same rule, since it starts on a bracket.
 */
const WPP = /^([A-Za-z][A-Za-z0-9_-]*)\(\s*["'][\s\S]*["']\s*\)[,;]?$/;

function wppGroups(lines: Line[]): Marker[] {
  const found: Marker[] = [];

  lines.forEach((line, index) => {
    const match = WPP.exec(line.text.trim());
    if (!match) return;
    const label = tagLabel(tidyLabel(match[1] ?? ''));
    if (!usableLabel(label)) return;
    found.push({ label, line: index });
  });

  return found;
}

/* --- shared -------------------------------------------------------------------------- */

/**
 * The longest stretch of groups with nothing but blank lines between them.
 *
 * Attribute lines come in a block. A bracketed line further down — a stray `[Genre: fantasy]`
 * after two screens of example dialogue — is not part of that block, and taking it would
 * silently hand the last attribute every word in between.
 */
function contiguousRun(lines: Line[], groups: Marker[]): Marker[] {
  let best: Marker[] = [];
  let run: Marker[] = [];

  for (const group of groups) {
    const previous = run[run.length - 1];
    if (previous && !onlyBlankBetween(lines, previous.line, group.line)) run = [];
    run.push(group);
    if (run.length > best.length) best = [...run];
  }

  return best;
}

function onlyBlankBetween(lines: Line[], from: number, to: number): boolean {
  for (let i = from + 1; i < to; i++) {
    if (lines[i]?.text.trim()) return false;
  }
  return true;
}

/** Each heading owns its own line and everything under it, up to the next one. */
function headingParts(
  text: string,
  lines: Line[],
  headings: Marker[],
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

/**
 * Each group owns its own line and no more.
 *
 * The opposite of a heading, and the reason these do not share one function: an attribute
 * line is complete in itself, so it has no claim on what follows it. Whatever sits after the
 * run — the example dialogue that usually does — becomes one last section under the field's
 * own name, which is what the reader would have called it anyway.
 */
function groupParts(
  text: string,
  lines: Line[],
  groups: Marker[],
  fallbackLabel: string,
): SplitPart[] {
  const parts: SplitPart[] = [];
  const first = lines[groups[0]?.line ?? 0]?.start ?? 0;
  if (text.slice(0, first).trim()) parts.push({ label: fallbackLabel, start: 0, end: first });

  const lastLine = groups[groups.length - 1]?.line ?? 0;
  const runEnd = lines[lastLine + 1]?.start ?? text.length;

  groups.forEach((group, index) => {
    const next = groups[index + 1];
    parts.push({
      label: group.label,
      start: parts.length ? (lines[group.line]?.start ?? 0) : 0,
      end: next ? (lines[next.line]?.start ?? runEnd) : runEnd,
    });
  });

  const tail = text.slice(runEnd);
  if (!tail) return parts;
  // Trailing whitespace is not a section; it joins the last group so the partition still
  // reaches the end.
  if (tail.trim()) parts.push({ label: fallbackLabel, start: runEnd, end: text.length });
  else if (parts[parts.length - 1]) (parts[parts.length - 1] as SplitPart).end = text.length;

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
