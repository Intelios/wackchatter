/**
 * The Inspect tool's rules, pure so they are pinned by tests: every reply in a chat as a
 * row of phases, the scale the rows share, a reply's lanes, the prompt it sent as blocks,
 * and what changed since the one before.
 */

import type { MessageState } from '@shared/chat/message.ts';
import { isFilteredStop } from '@shared/providers/sse.ts';
import type { ApiMessage, MessageExtra, ReplyTrace } from '@shared/types/chat.ts';
import type { PromptInspection } from '../features/chat/state/chatReducer.ts';

export type Phase = 'prep' | 'wait' | 'think' | 'write';
export type Outcome = ReplyTrace['outcome'] | 'live' | 'unknown';

/** One attempt at a reply: a swipe, a stopped or failed try, or the one being written. */
export interface Attempt {
  /** Stable across renders: the generation id when there is one. */
  key: string;
  /** The message it belongs to. Null for a try that left no message. */
  messageId: string | null;
  /** Its swipe, when it is one. */
  swipe: number | null;
  /** The swipe on screen for its message. */
  shown: boolean;
  trace?: ReplyTrace;
  /** Start to end in ms, when known. Null while live. */
  total: number | null;
  outcome: Outcome;
  /** When it started, epoch ms, for ordering. */
  at: number;
  /** The prompt it sent, while the session keeps it. */
  inspection?: PromptInspection;
  extra?: MessageExtra;
  kind: 'reply' | 'impersonation';
}

/** A row group: one reply and its other attempts. */
export interface Turn {
  /** 1-based, oldest first. Null for a try that left no message. */
  n: number | null;
  messageId: string | null;
  /** The attempt the row shows: the swipe on screen, else the newest. */
  main: Attempt;
  /** Every attempt, oldest first, `main` included. */
  attempts: Attempt[];
  at: number;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function outcomeOf(trace: ReplyTrace | undefined, extra: MessageExtra | undefined): Outcome {
  if (trace) return trace.outcome;
  // From before traces were kept: the provider's own reason still says a filter ended it.
  if (isFilteredStop(extra?.finish_reason)) return 'filtered';
  return extra?.truncated ? 'unknown' : 'finished';
}

/**
 * Every reply in the chat, oldest first, with the tries that left no message placed by
 * time. A message with no timing at all (a greeting) is not a reply.
 */
export function chatTurns(
  messages: readonly MessageState[],
  inspections: readonly PromptInspection[],
  liveMessageId: string | null,
): Turn[] {
  const byGeneration = new Map<string, PromptInspection>();
  for (const inspection of inspections) {
    if (inspection.generationId) byGeneration.set(inspection.generationId, inspection);
  }
  const used = new Set<PromptInspection>();
  const turns: Turn[] = [];

  for (const message of messages) {
    if (message.is_user) continue;
    const attempts: Attempt[] = [];
    message.swipe_info.forEach((info, swipe) => {
      const extra = info.extra;
      const trace = extra?.trace;
      const started = parseTime(info.gen_started);
      const finished = parseTime(info.gen_finished);
      const total =
        trace?.end ?? (started !== null && finished !== null ? finished - started : null);
      if (total === null || total < 0) return;
      const id = typeof extra?.generation_id === 'string' ? extra.generation_id : undefined;
      const inspection = id ? byGeneration.get(id) : undefined;
      if (inspection) used.add(inspection);
      attempts.push({
        key: id ?? `${message.id}:${swipe}`,
        messageId: message.id,
        swipe,
        shown: swipe === message.swipe_id,
        ...(trace ? { trace } : {}),
        total,
        outcome: outcomeOf(trace, extra),
        at: started ?? finished ?? 0,
        ...(inspection ? { inspection } : {}),
        ...(extra ? { extra } : {}),
        kind: 'reply',
      });
    });
    // Tries on this message that left no swipe: failed ones, and the one being written.
    for (const inspection of inspections) {
      if (used.has(inspection) || inspection.messageId !== message.id) continue;
      const live = message.id === liveMessageId && !inspection.trace;
      if (!live && !inspection.trace) continue;
      used.add(inspection);
      // The one being written started when its placeholder did, before the prompt was built.
      const placed = live ? parseTime(message.swipe_info.at(-1)?.gen_started) : null;
      attempts.push(orphan(inspection, live, placed));
    }
    if (!attempts.length) continue;
    attempts.sort((a, b) => a.at - b.at);
    turns.push(turn(null, message.id, attempts));
  }

  turns.forEach((entry, index) => {
    entry.n = index + 1;
  });

  // Tries that left no message at all: a failed send, an impersonation.
  for (const inspection of inspections) {
    if (used.has(inspection) || !inspection.trace) continue;
    if (inspection.messageId && messages.some((m) => m.id === inspection.messageId)) continue;
    const entry = turn(null, null, [orphan(inspection, false)]);
    const index = turns.findIndex((other) => other.at > entry.at);
    turns.splice(index === -1 ? turns.length : index, 0, entry);
  }
  return turns;
}

function orphan(inspection: PromptInspection, live: boolean, startedAt?: number | null): Attempt {
  const trace = inspection.trace;
  return {
    key: inspection.generationId ?? `at:${inspection.at}`,
    messageId: inspection.messageId ?? null,
    swipe: null,
    shown: false,
    ...(trace ? { trace } : {}),
    total: live ? null : (trace?.end ?? null),
    outcome: live ? 'live' : (trace?.outcome ?? 'unknown'),
    // The inspection is taken once the prompt is built, so back up to when it started.
    at: startedAt ?? inspection.at - (trace?.sent ?? 0),
    inspection,
    kind: inspection.generationType === 'impersonate' ? 'impersonation' : 'reply',
  };
}

function turn(n: number | null, messageId: string | null, attempts: Attempt[]): Turn {
  const main =
    attempts.find((a) => a.outcome === 'live') ??
    attempts.find((a) => a.shown) ??
    (attempts.at(-1) as Attempt);
  return { n, messageId, main, attempts, at: attempts[0]?.at ?? 0 };
}

/** How long each phase took. A reply from before tracing has only its total. */
export function phases(attempt: Attempt): { phase: Phase | 'whole'; ms: number }[] {
  const trace = attempt.trace;
  if (!trace) return attempt.total === null ? [] : [{ phase: 'whole', ms: attempt.total }];
  const firstBack = trace.thinking ?? trace.writing ?? trace.end;
  const out: { phase: Phase; ms: number }[] = [
    { phase: 'prep', ms: trace.sent },
    { phase: 'wait', ms: Math.max(0, firstBack - trace.sent) },
  ];
  if (trace.thinking !== undefined) {
    out.push({ phase: 'think', ms: Math.max(0, (trace.writing ?? trace.end) - trace.thinking) });
  }
  if (trace.writing !== undefined) {
    out.push({ phase: 'write', ms: Math.max(0, trace.end - trace.writing) });
  }
  return out;
}

/**
 * The clock the rows share. One very slow reply would squash the rest, so it stops a
 * little past the slow end of normal, in whole seconds; longer bars run off the edge.
 */
export function rowScale(totals: readonly number[]): number {
  const known = totals.filter((t) => t > 0).sort((a, b) => a - b);
  if (!known.length) return 1000;
  const p90 = known[Math.floor((known.length - 1) * 0.9)] as number;
  return Math.max(1000, Math.ceil((p90 * 1.35) / 1000) * 1000);
}

/** The middle and the slowest of a set of replies. */
export function turnStats(turns: readonly Turn[]): { median: number; slowest: Turn } | null {
  const timed = turns.filter((t) => t.main.total !== null);
  if (!timed.length) return null;
  const totals = timed.map((t) => t.main.total as number).sort((a, b) => a - b);
  const slowest = timed.reduce((best, t) =>
    (t.main.total as number) > (best.main.total as number) ? t : best,
  );
  return { median: totals[Math.floor(totals.length / 2)] as number, slowest };
}

/** The run of rows shown under the strip: `size` replies around the picked one. */
export function stripWindow(count: number, picked: number, size = 20): [number, number] {
  if (count <= size) return [0, Math.max(0, count - 1)];
  const last = Math.min(count - 1, Math.max(picked + Math.floor(size / 2) - 1, size - 1));
  return [last - size + 1, last];
}

export interface Lane {
  id: 'prep' | 'lore' | 'memory' | 'wait' | 'think' | 'write';
  start: number;
  ms: number;
}

/** A reply's lanes on its own clock. Lore and memory sit inside building the prompt. */
export function traceLanes(trace: ReplyTrace): Lane[] {
  const lanes: Lane[] = [{ id: 'prep', start: 0, ms: trace.sent }];
  if (trace.lore) lanes.push({ id: 'lore', start: 0, ms: trace.lore.ms });
  if (trace.memory) {
    lanes.push({ id: 'memory', start: trace.lore?.ms ?? 0, ms: trace.memory.ms });
  }
  if (trace.outcome === 'failed' && trace.sent === trace.end) return lanes;
  const firstBack = trace.thinking ?? trace.writing ?? trace.end;
  lanes.push({ id: 'wait', start: trace.sent, ms: Math.max(0, firstBack - trace.sent) });
  if (trace.thinking !== undefined) {
    const until = trace.writing ?? trace.end;
    lanes.push({ id: 'think', start: trace.thinking, ms: Math.max(0, until - trace.thinking) });
  }
  if (trace.writing !== undefined) {
    lanes.push({ id: 'write', start: trace.writing, ms: Math.max(0, trace.end - trace.writing) });
  }
  return lanes;
}

// ---------- The prompt ----------

/** Where a block came from, for its colour. */
export type Source = 'mine' | 'card' | 'you' | 'lore' | 'memory' | 'history';

export function sourceOf(identifier: string): Source {
  switch (identifier) {
    case 'chatHistory':
    case 'newChatPrompt':
    case 'sendIfEmpty':
      return 'history';
    case 'worldInfoBefore':
    case 'worldInfoAfter':
    case 'worldInfoDepth':
      return 'lore';
    case 'charDescription':
    case 'charPersonality':
    case 'scenario':
    case 'dialogueExamples':
      return 'card';
    case 'personaDescription':
      return 'you';
    case 'memories':
    case 'summary':
      return 'memory';
    default:
      return 'mine';
  }
}

export interface Names {
  char: string;
  persona: string | null;
  /** The preset's own names for its prompts, by identifier. */
  prompts: ReadonlyMap<string, string>;
}

export function blockName(identifier: string, names: Names): string {
  switch (identifier) {
    case 'main':
      return 'Main prompt';
    case 'jailbreak':
      return 'Post-history instructions';
    case 'nsfw':
      return 'Auxiliary prompt';
    case 'enhanceDefinitions':
      return 'Enhance definitions';
    case 'charDescription':
      return `${names.char} · description`;
    case 'charPersonality':
      return `${names.char} · personality`;
    case 'scenario':
      return 'Scenario';
    case 'personaDescription':
      return names.persona ? `Your persona · ${names.persona}` : 'Your persona';
    case 'dialogueExamples':
      return 'Example dialogue';
    case 'worldInfoBefore':
      return 'Lore, before the card';
    case 'worldInfoAfter':
      return 'Lore, after the card';
    case 'worldInfoDepth':
      return 'Lore, in the chat';
    case 'authorNote':
      return 'Author’s note';
    case 'memories':
      return 'Story memory';
    case 'summary':
      return 'Summary';
    case 'guides':
      return 'Guides';
    case 'guidance':
      return 'Guidance';
    case 'impersonate':
      return 'Impersonation prompt';
    case 'newChatPrompt':
      return 'New chat marker';
    case 'continueNudge':
      return 'Continue nudge';
    case 'sendIfEmpty':
      return 'Empty message filler';
    case 'chatHistory':
      return 'Chat history';
    default:
      return names.prompts.get(identifier) ?? identifier;
  }
}

export interface Block {
  /** Stable within one prompt: its sources, and which run of them it is. */
  key: string;
  /** Its sources, joined: what "since the one before" compares. */
  id: string;
  sources: string[];
  source: Source;
  name: string;
  role: ApiMessage['role'] | 'mixed';
  messages: ApiMessage[];
  /** A run of the transcript, shown as its messages. */
  history: boolean;
}

/**
 * The prompt in the order it was sent, as blocks: one per prompt, the transcript as runs
 * of messages (an injection in the middle splits it), example dialogue as one block.
 */
export function promptBlocks(inspection: PromptInspection, names: Names): Block[] {
  const origins = inspection.origins ?? [];
  const blocks: Block[] = [];
  const seen = new Map<string, number>();
  inspection.messages.forEach((message, index) => {
    const sources = origins[index]?.length ? (origins[index] as string[]) : ['unknown'];
    const id = sources.join('+');
    const grouped = id === 'chatHistory' || id === 'dialogueExamples';
    const last = blocks.at(-1);
    if (grouped && last?.id === id) {
      last.messages.push(message);
      if (last.role !== message.role) last.role = 'mixed';
      return;
    }
    const run = (seen.get(id) ?? 0) + 1;
    seen.set(id, run);
    blocks.push({
      key: `${id}#${run}`,
      id,
      sources,
      source: sourceOf(sources[0] as string),
      name: sources.map((source) => blockName(source, names)).join(' + '),
      role: message.role,
      messages: [message],
      history: id === 'chatHistory',
    });
  });
  return blocks;
}

export interface Change {
  sign: '+' | '-' | '~';
  text: string;
}

export interface PromptDiff {
  changes: Change[];
  /** Blocks that were not there the time before, or whose text changed, by `id`. */
  marks: Map<string, 'new' | 'edited'>;
  /** Blocks that were there the time before and are not now. */
  gone: Block[];
}

/**
 * What changed since the prompt before: lore that came and went, memory, a dropped
 * message, and any prompt that is new, gone or edited. The transcript always moves on, so
 * it is not reported; neither is lore's text, which the lore chips already account for.
 */
export function promptDiff(
  before: PromptInspection,
  now: PromptInspection,
  names: Names,
): PromptDiff {
  const changes: Change[] = [];
  const was = new Set(before.lore ?? []);
  const is = new Set(now.lore ?? []);
  for (const name of is) if (!was.has(name)) changes.push({ sign: '+', text: `lore · ${name}` });
  for (const name of was) if (!is.has(name)) changes.push({ sign: '-', text: `lore · ${name}` });

  const recalledBefore = before.nexusRecall?.hits.length;
  const recalledNow = now.nexusRecall?.hits.length;
  if (recalledBefore !== undefined && recalledNow !== undefined && recalledBefore !== recalledNow) {
    changes.push({ sign: '~', text: `${recalledNow} memories, was ${recalledBefore}` });
  }

  const dropped = now.droppedMessages - before.droppedMessages;
  if (dropped > 0) {
    changes.push({
      sign: '-',
      text: `${dropped} old ${dropped === 1 ? 'message' : 'messages'} no longer fit`,
    });
  }

  const text = (blocks: Block[]) => {
    const out = new Map<string, string>();
    for (const block of blocks) {
      if (block.history || block.source === 'lore') continue;
      const joined = block.messages.map((m) => m.content).join('\n');
      out.set(block.id, (out.has(block.id) ? `${out.get(block.id)}\n` : '') + joined);
    }
    return out;
  };
  const beforeBlocks = promptBlocks(before, names);
  const nowBlocks = promptBlocks(now, names);
  const textBefore = text(beforeBlocks);
  const textNow = text(nowBlocks);
  const marks = new Map<string, 'new' | 'edited'>();
  for (const [id, content] of textNow) {
    const old = textBefore.get(id);
    const name = nowBlocks.find((b) => b.id === id)?.name ?? id;
    if (old === undefined) {
      marks.set(id, 'new');
      changes.push({ sign: '+', text: name });
    } else if (old !== content) {
      marks.set(id, 'edited');
      changes.push({ sign: '~', text: `${name} edited` });
    }
  }
  const gone: Block[] = [];
  for (const id of textBefore.keys()) {
    if (textNow.has(id)) continue;
    const block = beforeBlocks.find((b) => b.id === id) as Block;
    gone.push(block);
    changes.push({ sign: '-', text: block.name });
  }
  return { changes, marks, gone };
}

/** The kept prompt that came just before this one in the same chat. */
export function previousInspection(
  inspections: readonly PromptInspection[],
  now: PromptInspection,
): PromptInspection | null {
  let best: PromptInspection | null = null;
  for (const other of inspections) {
    if (other === now || other.chatId !== now.chatId || other.at >= now.at) continue;
    if (other.generationType === 'impersonate' || !other.body) continue;
    if (!best || other.at > best.at) best = other;
  }
  return best;
}

/** A duration the way the tool writes it. */
export function seconds(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 120000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
