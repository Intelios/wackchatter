/**
 * The Studio's reading of a card, as pure functions: its sections and what each costs, the
 * few things that are really wrong with it, what changed since it was opened, and its
 * example dialogue as a conversation.
 */

import { createMacroRuntime, substituteMacros } from '@shared/prompt/macros.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { WorldInfoEntry } from '@shared/types/worldinfo.ts';

// ---------- Sections ----------

export const STUDIO_SECTIONS = [
  { id: 'identity', label: 'Identity' },
  { id: 'definition', label: 'Definition' },
  { id: 'greetings', label: 'Greetings' },
  { id: 'examples', label: 'Examples' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'lorebook', label: 'Lorebook' },
  { id: 'metadata', label: 'Metadata' },
] as const;

export type StudioSection = (typeof STUDIO_SECTIONS)[number]['id'];

/** The text fields the Studio edits, with where each lives and what it is called. */
export const TEXT_FIELDS = {
  description: { section: 'definition', label: 'Description' },
  personality: { section: 'definition', label: 'Personality' },
  scenario: { section: 'definition', label: 'Scenario' },
  first_mes: { section: 'greetings', label: 'First message' },
  mes_example: { section: 'examples', label: 'Example dialogue' },
  system_prompt: { section: 'prompts', label: 'System prompt' },
  post_history_instructions: { section: 'prompts', label: 'Post-history instructions' },
  creator_notes: { section: 'metadata', label: 'Creator notes' },
} as const satisfies Record<string, { section: StudioSection; label: string }>;

export type TextField = keyof typeof TEXT_FIELDS;

// ---------- Macros ----------

const MACRO = /\{\{[^{}]*\}\}/g;

const known = new Map<string, boolean>();

/**
 * Whether the macro engine resolves a `{{...}}`. Asked of the engine itself, not a list, so
 * the Studio and a real chat can never disagree about what is unknown.
 */
export function macroKnown(raw: string): boolean {
  const cached = known.get(raw);
  if (cached !== undefined) return cached;
  const runtime = createMacroRuntime();
  substituteMacros(raw, { char: 'Character', user: 'User' }, '', { runtime, source: 'studio' });
  const ok = runtime.warnings.length === 0;
  if (known.size > 500) known.clear();
  known.set(raw, ok);
  return ok;
}

export interface TextPart {
  text: string;
  /** A macro: true when the engine knows it, false when it does not. */
  macro?: boolean;
}

/** Text split into plain runs and macros, for drawing the macros as chips. */
export function macroParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const match of text.matchAll(MACRO)) {
    const index = match.index ?? 0;
    if (index > at) parts.push({ text: text.slice(at, index) });
    parts.push({ text: match[0], macro: macroKnown(match[0]) });
    at = index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

export function unknownMacros(text: string): string[] {
  return [...new Set([...text.matchAll(MACRO)].map((m) => m[0]))].filter((m) => !macroKnown(m));
}

// ---------- What is really wrong ----------

export interface StudioProblem {
  section: StudioSection;
  text: string;
  /** Which field or item, in words. */
  where: string;
}

/**
 * Only what breaks the card: no name, a chat that would open blank, a macro nothing can
 * resolve, a lore entry that can never fire. Style and completeness are the writer's call.
 */
export function studioProblems(
  data: CardDataV2,
  entries: readonly WorldInfoEntry[],
): StudioProblem[] {
  const problems: StudioProblem[] = [];
  if (!data.name.trim()) {
    problems.push({ section: 'identity', text: 'The card has no name.', where: 'Name' });
  }
  if (!data.first_mes.trim()) {
    problems.push({
      section: 'greetings',
      text: 'The first message is empty, so new chats would open blank.',
      where: 'First message',
    });
  }
  const macros = (text: string, section: StudioSection, where: string) => {
    for (const macro of unknownMacros(text)) {
      problems.push({ section, text: `Unknown macro ${macro}`, where });
    }
  };
  for (const [key, field] of Object.entries(TEXT_FIELDS) as [
    TextField,
    (typeof TEXT_FIELDS)[TextField],
  ][]) {
    macros(data[key] ?? '', field.section, field.label);
  }
  data.alternate_greetings.forEach((text, index) => {
    macros(text, 'greetings', `Greeting ${index + 2}`);
  });
  for (const entry of entries) {
    const name = entry.comment.trim() || entry.key.find((k) => k.trim()) || `Entry ${entry.uid}`;
    if (!entry.disable && !entry.constant && !entry.key.some((key) => key.trim())) {
      problems.push({
        section: 'lorebook',
        text: 'This entry has no keys, so it can never fire.',
        where: name,
      });
    }
    macros(entry.content, 'lorebook', name);
  }
  return problems;
}

// ---------- What it costs ----------

export interface CostRow {
  key: string;
  label: string;
  section: StudioSection;
  tokens: number;
}

export interface CardCost {
  /** Sent with every reply: the card's text and its always-on lore. */
  always: CostRow[];
  alwaysTotal: number;
  firstMessage: number;
  longestGreeting: number;
  /** Each keyed entry, sent only when it fires. */
  lore: CostRow[];
  /** By section, for the rail. */
  bySection: Record<StudioSection, number>;
}

const count = (counter: TokenCounter, text: string | undefined) =>
  text?.trim() ? counter.countText(text) : 0;

export function cardCost(
  data: CardDataV2,
  entries: readonly WorldInfoEntry[],
  counter: TokenCounter,
): CardCost {
  const field = (key: TextField, label: string): CostRow => ({
    key,
    label,
    section: TEXT_FIELDS[key].section,
    tokens: count(counter, data[key]),
  });
  const always = [
    field('description', 'Description'),
    field('personality', 'Personality'),
    field('scenario', 'Scenario'),
    field('mes_example', 'Examples'),
    field('system_prompt', 'System prompt'),
    field('post_history_instructions', 'Post-history'),
  ];
  const live = entries.filter((entry) => !entry.disable);
  const constant = live
    .filter((entry) => entry.constant)
    .reduce((total, entry) => total + count(counter, entry.content), 0);
  if (constant) {
    always.push({ key: 'lore', label: 'Always-on lore', section: 'lorebook', tokens: constant });
  }
  const greetings = [data.first_mes, ...data.alternate_greetings].map((text) =>
    count(counter, text),
  );
  const lore = live
    .filter((entry) => !entry.constant)
    .map((entry) => ({
      key: `lore:${entry.uid}`,
      label: entry.comment.trim() || entry.key.find((k) => k.trim()) || `Entry ${entry.uid}`,
      section: 'lorebook' as const,
      tokens: count(counter, entry.content),
    }));
  const sum = (section: StudioSection) =>
    always.filter((row) => row.section === section).reduce((t, row) => t + row.tokens, 0);
  return {
    always: always.filter((row) => row.tokens > 0),
    alwaysTotal: always.reduce((total, row) => total + row.tokens, 0),
    firstMessage: greetings[0] ?? 0,
    longestGreeting: Math.max(0, ...greetings),
    lore,
    bySection: {
      identity: 0,
      definition: sum('definition'),
      greetings: greetings[0] ?? 0,
      examples: sum('examples'),
      prompts: sum('prompts'),
      lorebook: constant,
      metadata: 0,
    },
  };
}

// ---------- Since you opened it ----------

/** What a change is about, and so how it is put back. */
export type ChangeTarget =
  | { kind: 'field'; key: ChangeField }
  | { kind: 'name' }
  | { kind: 'folder' }
  | { kind: 'entry'; uid: number }
  | { kind: 'added-entry'; uid: number };

export type ChangeField =
  | TextField
  | 'creator'
  | 'character_version'
  | 'nickname'
  | 'tags'
  | 'alternate_greetings'
  | 'source'
  | 'world';

export interface CardChange {
  id: string;
  label: string;
  target: ChangeTarget;
  /** A short line of what changed: before and after, or, for text, where it differs. */
  before: string;
  after: string;
  diff?: TextDiff;
}

const LINE_FIELDS: readonly [ChangeField, string][] = [
  ['description', 'Description'],
  ['personality', 'Personality'],
  ['scenario', 'Scenario'],
  ['first_mes', 'First message'],
  ['mes_example', 'Example dialogue'],
  ['system_prompt', 'System prompt'],
  ['post_history_instructions', 'Post-history instructions'],
  ['creator_notes', 'Creator notes'],
  ['creator', 'Creator'],
  ['character_version', 'Version'],
  ['nickname', 'Nickname'],
];

/** Where two texts differ: what was taken out and put in, with a little either side. */
export interface TextDiff {
  lead: string;
  gone: string;
  added: string;
  tail: string;
}

/** The bit of two texts that differs, with a little lead-in and tail, each side clipped. */
export function diffSnippet(before: string, after: string): TextDiff {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  const flat = (text: string) => text.replace(/\s+/g, ' ');
  const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);
  const lead = flat(before.slice(Math.max(0, start - 16), start));
  const rest = after.slice(after.length - end);
  return {
    lead: start > 16 ? `…${lead}` : lead,
    gone: clip(flat(before.slice(start, before.length - end))),
    added: clip(flat(after.slice(start, after.length - end))),
    tail: flat(rest.slice(0, 12)) + (rest.length > 12 ? '…' : ''),
  };
}

/** Bookkeeping, not content: where an entry sits in a list moves with every reorder. */
const NOT_CONTENT = new Set(['uid', 'displayIndex']);

/** Everything about an entry the Studio can put back, as it was. */
export function entryPatch(entry: WorldInfoEntry): Partial<WorldInfoEntry> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !NOT_CONTENT.has(key)));
}

const entrySame = (a: WorldInfoEntry, b: WorldInfoEntry) =>
  JSON.stringify(entryPatch(a)) === JSON.stringify(entryPatch(b));

const entryName = (entry: WorldInfoEntry) =>
  entry.comment.trim() || entry.key.find((k) => k.trim()) || `Entry ${entry.uid}`;

/**
 * Everything that differs from the card as it was when it was opened, one item per thing
 * that can be put back on its own. Entries deleted since have no item: they cannot return.
 */
export function cardChanges(
  opened: { data: CardDataV2; folder: string; entries: readonly WorldInfoEntry[] },
  now: { data: CardDataV2; folder: string; entries: readonly WorldInfoEntry[] },
): CardChange[] {
  const changes: CardChange[] = [];
  if (opened.data.name !== now.data.name) {
    changes.push({
      id: 'name',
      label: 'Name',
      target: { kind: 'name' },
      before: opened.data.name,
      after: now.data.name,
    });
  }
  if (opened.folder !== now.folder) {
    changes.push({
      id: 'folder',
      label: 'Folder',
      target: { kind: 'folder' },
      before: opened.folder || 'Top level',
      after: now.folder || 'Top level',
    });
  }
  for (const [key, label] of LINE_FIELDS) {
    const before = String(opened.data[key as keyof CardDataV2] ?? '');
    const after = String(now.data[key as keyof CardDataV2] ?? '');
    if (before !== after) {
      changes.push({
        id: key,
        label,
        target: { kind: 'field', key },
        before: '',
        after: '',
        diff: diffSnippet(before, after),
      });
    }
  }
  const list = (key: 'tags' | 'source' | 'alternate_greetings', label: string, noun: string) => {
    const before = opened.data[key] ?? [];
    const after = now.data[key] ?? [];
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const same = before.length === after.length;
    const reordered = same && [...before].sort().join('\0') === [...after].sort().join('\0');
    changes.push({
      id: key,
      label,
      target: { kind: 'field', key },
      before: same ? (reordered ? 'Reordered' : 'Edited') : `${before.length} ${noun}`,
      after: same ? '' : `${after.length} ${noun}`,
    });
  };
  list('alternate_greetings', 'Alternate greetings', 'greetings');
  list('tags', 'Tags', 'tags');
  list('source', 'Source', 'sources');
  const world = (data: CardDataV2) =>
    typeof data.extensions.world === 'string' ? data.extensions.world : '';
  if (world(opened.data) !== world(now.data)) {
    changes.push({
      id: 'world',
      label: 'Linked lorebook',
      target: { kind: 'field', key: 'world' },
      before: world(opened.data) || 'None',
      after: world(now.data) || 'None',
    });
  }
  const was = new Map(opened.entries.map((entry) => [entry.uid, entry]));
  for (const entry of now.entries) {
    const old = was.get(entry.uid);
    if (!old) {
      changes.push({
        id: `entry:${entry.uid}`,
        label: `Lore: ${entryName(entry)}`,
        target: { kind: 'added-entry', uid: entry.uid },
        before: 'New entry',
        after: '',
      });
    } else if (!entrySame(old, entry)) {
      changes.push({
        id: `entry:${entry.uid}`,
        label: `Lore: ${entryName(old)}`,
        target: { kind: 'entry', uid: entry.uid },
        before: old.content === entry.content ? 'Settings changed' : '',
        after: '',
        diff: old.content === entry.content ? undefined : diffSnippet(old.content, entry.content),
      });
    }
  }
  return changes;
}

// ---------- Example dialogue as a conversation ----------

export interface ExampleTurn {
  who: 'user' | 'char';
  text: string;
}

const SPEAKER = /^\{\{(user|char)\}\}:[ \t]?(.*)$/i;

/**
 * The example dialogue as conversations, or null when it is not written as `<START>`
 * blocks of `{{user}}:` / `{{char}}:` lines. Null keeps it raw: reading anything else as a
 * conversation would lose the lines that are not a speaker's.
 */
export function parseExamples(text: string): ExampleTurn[][] | null {
  if (!text.trim()) return [];
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!/^<START>/i.test(body)) return null;
  const blocks: ExampleTurn[][] = [];
  for (const chunk of body.split(/^<START>[ \t]*$/im).slice(1)) {
    const turns: ExampleTurn[] = [];
    for (const line of chunk.replace(/^\n+|\n+$/g, '').split('\n')) {
      const speaker = SPEAKER.exec(line);
      if (speaker)
        turns.push({ who: speaker[1]?.toLowerCase() as 'user' | 'char', text: speaker[2] ?? '' });
      else if (turns.length) (turns[turns.length - 1] as ExampleTurn).text += `\n${line}`;
      else if (line.trim()) return null;
    }
    for (const turn of turns) turn.text = turn.text.replace(/\n+$/, '');
    blocks.push(turns);
  }
  return blocks;
}

/** Conversations back to SillyTavern's example format. */
export function joinExamples(blocks: readonly (readonly ExampleTurn[])[]): string {
  return blocks
    .map((turns) => ['<START>', ...turns.map((turn) => `{{${turn.who}}}: ${turn.text}`)].join('\n'))
    .join('\n');
}

// ---------- Lists ----------

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}

/** When a card entry fires, said plainly: the Studio has no last reply to point at. */
export function entryWhen(entry: WorldInfoEntry, scanDepth: number): string {
  if (entry.disable) return 'Switched off, so it is never sent.';
  if (entry.constant) return 'Always on: sent with every reply.';
  const keys = entry.key.filter((key) => key.trim());
  if (!keys.length) return 'It has no keys, so it never fires.';
  const depth = entry.scanDepth ?? scanDepth;
  const shown = keys.slice(0, 3).map((key) => `‘${key}’`);
  const named =
    keys.length > 3
      ? `${shown.join(', ')} or ${keys.length - 3} more`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} or ${shown[shown.length - 1]}`
        : shown[0];
  return `Fires when ${named} comes up in the last ${depth === 1 ? 'message' : `${depth} messages`}.`;
}

/** "just now", "12 min ago", "3 h ago", "yesterday", then the date. */
export function editedWhen(ms: number, now: number): string {
  const seconds = (now - ms) / 1000;
  if (!Number.isFinite(seconds) || seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const days = Math.floor(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `${Math.floor(seconds / 3600)} h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function kTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
}
