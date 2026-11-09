/**
 * The Memory tool's reading of a summary, as pure functions: its sections, what changed
 * since the version before, and where each message of the chat stands against it.
 */

import { messageFingerprint } from '@shared/nexus/state.ts';
import type { ChatMessage, StorySummary } from '@shared/types/chat.ts';
import { SUMMARY_HIDDEN, summarisable, summaryCoverage } from '../features/summary/coverage.ts';

// ---------- Sections ----------

export interface MemorySection {
  /** The `## ` heading, or null for text before the first one (or a summary without any). */
  title: string | null;
  /** Everything under the heading, as written. */
  body: string;
}

const HEADING = /^##\s+(.+?)\s*$/;

/** Split a summary at its `## ` headings. Text with none is one untitled section. */
export function memorySections(text: string): MemorySection[] {
  const sections: MemorySection[] = [];
  let current: { title: string | null; lines: string[] } = { title: null, lines: [] };
  const close = () => {
    const body = current.lines.join('\n').trim();
    if (current.title !== null || body) sections.push({ title: current.title, body });
  };
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      current = { title: heading[1] as string, lines: [] };
    } else current.lines.push(line);
  }
  close();
  return sections;
}

/** The summary with section `index`'s body replaced; the others stay exactly as they were. */
export function withSection(text: string, index: number, body: string): string {
  return memorySections(text)
    .map((section, at) => {
      const content = (at === index ? body : section.body).trim();
      if (section.title === null) return content;
      return content ? `## ${section.title}\n${content}` : `## ${section.title}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export interface MemoryLine {
  /** A bullet point, or a plain line of text. */
  kind: 'item' | 'text';
  text: string;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** A section's body as lines to show: bullets lose their marker, blank lines go. */
export function sectionLines(body: string): MemoryLine[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      BULLET.test(line)
        ? { kind: 'item', text: line.replace(BULLET, '').trim() }
        : { kind: 'text', text: line },
    );
}

export interface InlinePart {
  text: string;
  strong?: boolean;
  em?: boolean;
}

/** `**bold**` and `*italic*`, the only markdown a memory line uses; the rest stays text. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > at) parts.push({ text: text.slice(at, index) });
    if (match[1] !== undefined) parts.push({ text: match[1], strong: true });
    else parts.push({ text: match[2] as string, em: true });
    at = index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

// ---------- What changed since the version before ----------

export type LineChange = 'new' | 'changed';

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * The lines of `now` that `before` didn't have, keyed by section and line text. A line that
 * shares most of its words with one that went missing from the same section reads as
 * changed; any other is new.
 */
export function memoryChanges(now: string, before: string): Map<string, LineChange> {
  const changes = new Map<string, LineChange>();
  const old = new Map<string, string[]>();
  for (const section of memorySections(before)) {
    old.set(
      section.title ?? '',
      sectionLines(section.body).map((line) => line.text),
    );
  }
  for (const section of memorySections(now)) {
    const title = section.title ?? '';
    const previous = old.get(title) ?? [];
    const lines = sectionLines(section.body).map((line) => line.text);
    const kept = new Set(previous);
    const gone = previous.filter((line) => !lines.includes(line)).map(words);
    for (const line of lines) {
      if (kept.has(line)) continue;
      const mine = words(line);
      const near = gone.some((other) => overlap(mine, other) >= 0.5);
      changes.set(changeKey(title, line), near ? 'changed' : 'new');
    }
  }
  return changes;
}

export const changeKey = (title: string | null, line: string) => `${title ?? ''}\u0000${line}`;

// ---------- Where each message stands ----------

/**
 * `in`: in the memory. `hidden`: in the memory and hidden from the prompt by it. `changed`:
 * summarised, but edited or re-swiped since. `new`: not summarised yet. `out`: left out of
 * the memory (blank, or hidden by you).
 */
export type TickState = 'in' | 'hidden' | 'changed' | 'new' | 'out';

export interface TickRun {
  state: TickState;
  /** Index of the run's first message in the chat. */
  start: number;
  length: number;
}

export interface MemoryCoverage {
  runs: TickRun[];
  total: number;
  inMemory: number;
  changed: number;
  fresh: number;
  hidden: number;
  /** Where the summary's hiding stops: the index after its last hidden message, or 0. */
  cut: number;
  /** Each message's state, by index, for hover. */
  states: TickState[];
}

/** The chat as runs of messages in the same state, so a long chat draws in a few pieces. */
export function memoryCoverage(
  messages: readonly ChatMessage[],
  summary: StorySummary | undefined,
): MemoryCoverage {
  const usable = summarisable(messages);
  const coverage = summaryCoverage(usable, summary);
  const covered = new Set(coverage.fingerprints);
  const firstNew = usable.length - coverage.backlog.length;
  const place = new Map(usable.map((message, index) => [message.id, index]));

  const states = messages.map((message): TickState => {
    const at = place.get(message.id);
    if (at === undefined) return 'out';
    if (at >= firstNew) return 'new';
    const print = messageFingerprint({ ...message, mes: message.mes.trim() });
    if (!covered.has(print)) return 'changed';
    return message.is_system && message.hiddenBy === SUMMARY_HIDDEN ? 'hidden' : 'in';
  });

  const runs: TickRun[] = [];
  let cut = 0;
  states.forEach((state, index) => {
    const last = runs[runs.length - 1];
    if (last && last.state === state) last.length++;
    else runs.push({ state, start: index, length: 1 });
    if (state === 'hidden') cut = index + 1;
  });
  const count = (state: TickState) => states.filter((s) => s === state).length;
  const hidden = count('hidden');
  return {
    runs,
    total: messages.length,
    inMemory: count('in') + hidden,
    changed: count('changed'),
    fresh: count('new'),
    hidden,
    cut,
    states,
  };
}

// ---------- Words ----------

/** "just now", "12 min ago", "3 h ago", "yesterday", then the date. */
export function whenWritten(iso: string | undefined, now: Date): string {
  if (!iso) return 'Earlier';
  const then = new Date(iso);
  const seconds = (now.getTime() - then.getTime()) / 1000;
  if (!Number.isFinite(seconds)) return 'Earlier';
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const days = Math.floor(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `${Math.floor(seconds / 3600)} h ago`;
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function kTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
}
