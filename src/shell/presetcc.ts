/**
 * The Preset Co-Creator's pure parts: what the preset rail lists and lights, what a test
 * knows about the draft it ran on, a rerun's before and after, and what the session cost.
 */

import { getPromptOrder } from '@shared/prompt/preset-io.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type {
  PresetCocreatorDocument,
  PresetCocreatorMessage,
  PresetCocreatorSessionSummary,
  PresetDraftRevision,
  PresetTest,
  PresetTestEvidence,
} from '@shared/types/preset-cocreator.ts';
import { buildSideBySide } from '../features/preset-cocreator/presetCompare.ts';
import { presetChanges } from './preset.ts';

// ---------- The rail ----------

export interface RailRow {
  identifier: string;
  name: string;
  enabled: boolean;
  /** Filled in by the app (chat history, the card's fields): it has no text of its own. */
  marker: boolean;
  content: string;
}

/** The live order as the rail lists it: what's sent, top to bottom, switched-off rows too. */
export function railRows(preset: Preset): RailRow[] {
  const prompts = new Map((preset.prompts ?? []).map((p) => [p.identifier, p]));
  return getPromptOrder(preset).flatMap((entry) => {
    const prompt = prompts.get(entry.identifier);
    if (!prompt) return [];
    return [
      {
        identifier: entry.identifier,
        name: prompt.name?.trim() || entry.identifier,
        enabled: entry.enabled !== false,
        marker: prompt.marker === true,
        content: typeof prompt.content === 'string' ? prompt.content : '',
      },
    ];
  });
}

/**
 * The revisions the rail lights when it shows `revision`: that one, and for the newest the
 * whole of the Co-Creator turn that made it, so a turn that edited twice lights both.
 */
export function litRevisions(
  history: readonly PresetDraftRevision[],
  revision: number,
): PresetDraftRevision[] {
  const sorted = [...history].sort((a, b) => a.revision - b.revision);
  const at = sorted.findIndex((entry) => entry.revision === revision);
  if (at <= 0) return [];
  const shown = sorted[at]!;
  if (!shown.turnId) return [shown];
  let first = at;
  while (first > 1 && sorted[first - 1]!.turnId === shown.turnId) first -= 1;
  return sorted.slice(first, at + 1);
}

/** The prompts changed by the lit revisions, by identifier. */
export function litPrompts(history: readonly PresetDraftRevision[], revision: number): Set<string> {
  const sorted = [...history].sort((a, b) => a.revision - b.revision);
  const lit = litRevisions(sorted, revision);
  if (!lit.length) return new Set();
  const before = sorted[sorted.indexOf(lit[0]!) - 1];
  const after = lit.at(-1)!;
  return new Set(presetChanges(before?.preset ?? null, after.preset).prompts);
}

export type CompareMark = 'same' | 'changed' | 'only-here' | 'only-there';

export interface CompareLens {
  /** Rows of this preset, by identifier. */
  marks: Map<string, CompareMark>;
  /** Prompts only the other preset has, by name, in its order. */
  onlyThere: { identifier: string; name: string }[];
  /** Settings that differ, by label. */
  settings: string[];
  differences: number;
}

/** This preset read against another: which rows differ, and what only the other one has. */
export function compareLens(here: Preset, there: Preset): CompareLens {
  const side = buildSideBySide(there, here);
  const marks = new Map<string, CompareMark>();
  const onlyThere: CompareLens['onlyThere'] = [];
  for (const row of side.prompts) {
    const identifier = row.key.replace(/^prompt:/, '');
    if (row.status === 'removed') onlyThere.push({ identifier, name: row.label });
    else
      marks.set(
        identifier,
        row.status === 'added' ? 'only-here' : row.status === 'changed' ? 'changed' : 'same',
      );
  }
  return {
    marks,
    onlyThere,
    settings: side.settings.filter((row) => row.status !== 'same').map((row) => row.label),
    differences: side.differences,
  };
}

// ---------- The bench ----------

export function latestReply(test: PresetTest): ChatMessage | null {
  return [...test.messages].reverse().find((message) => !message.is_user) ?? null;
}

/** The evidence behind one swipe of a reply, the selected one by default. */
export function swipeEvidence(
  test: PresetTest,
  message: ChatMessage,
  swipe = message.swipe_id ?? 0,
): PresetTestEvidence | null {
  const id =
    swipe === (message.swipe_id ?? 0)
      ? message.extra?.preset_test_evidence_id
      : message.swipe_info?.[swipe]?.extra?.preset_test_evidence_id;
  if (typeof id === 'string') {
    const found = test.evidence.find((entry) => entry.id === id);
    if (found) return found;
  }
  return (
    [...test.evidence]
      .reverse()
      .find((entry) => entry.messageId === message.id && entry.swipeIndex === swipe) ?? null
  );
}

/**
 * The revision the test's latest reply ran on, when that is older than the draft: the test
 * is out of date. Null when it runs another preset, has no reply yet, or is current.
 */
export function staleRevision(test: PresetTest, draftRevision: number): number | null {
  if (test.presetSource.kind !== 'draft') return null;
  const reply = latestReply(test);
  if (!reply || reply.swipes?.[reply.swipe_id ?? 0] === undefined) return null;
  if (test.messages.indexOf(reply) === 0) return null;
  const ran = swipeEvidence(test, reply)?.draftRevision;
  return typeof ran === 'number' && ran < draftRevision ? ran : null;
}

export interface RerunPair {
  messageId: string;
  /** Paragraphs both replies open with, shown once. */
  shared: string;
  before: { text: string; revision: number };
  after: { text: string; revision: number };
}

/**
 * A rerun's before and after: the latest reply's selected swipe was made by a rerun on a
 * newer revision than the swipe before it. Derived, so it survives a reload, and it stops
 * as soon as you move to another swipe or send.
 */
export function rerunPair(test: PresetTest): RerunPair | null {
  const reply = latestReply(test);
  if (!reply || reply !== test.messages.at(-1)) return null;
  const index = reply.swipe_id ?? 0;
  if (index < 1) return null;
  const after = swipeEvidence(test, reply, index);
  const before = swipeEvidence(test, reply, index - 1);
  if (!after || !before || after.kind !== 'swipe' || after.status !== 'complete') return null;
  if (after.draftRevision <= before.draftRevision) return null;
  const split = splitShared(reply.swipes?.[index - 1] ?? '', reply.swipes?.[index] ?? '');
  return {
    messageId: reply.id,
    shared: split.shared,
    before: { text: split.before, revision: before.draftRevision },
    after: { text: split.after, revision: after.draftRevision },
  };
}

/** Two texts as the paragraphs they open with in common, then where each goes its own way. */
export function splitShared(
  a: string,
  b: string,
): { shared: string; before: string; after: string } {
  const left = a.split(/\n{2,}/);
  const right = b.split(/\n{2,}/);
  let same = 0;
  while (
    same < left.length - 1 &&
    same < right.length - 1 &&
    left[same]!.trim() === right[same]!.trim()
  ) {
    same += 1;
  }
  return {
    shared: left.slice(0, same).join('\n\n'),
    before: left.slice(same).join('\n\n'),
    after: right.slice(same).join('\n\n'),
  };
}

/** Whether this reply, as it reads now, was already sent back to the Co-Creator. */
export function wasSentBack(
  messages: readonly PresetCocreatorMessage[],
  testId: string,
  reply: ChatMessage,
): boolean {
  return messages.some(
    (message) =>
      message.role === 'report' &&
      message.report?.testId === testId &&
      message.report.throughMessageId === reply.id &&
      message.report.replyText === reply.mes,
  );
}

// ---------- What it cost ----------

export interface Spend {
  connectionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Every recorded reply, the Co-Creator's and the bench's, summed per model. */
export function sessionSpend(document: PresetCocreatorDocument): Spend[] {
  const totals = new Map<string, Spend>();
  const add = (connectionId: string, model: string, input: number, output: number) => {
    const key = `${connectionId}\u0000${model}`;
    const entry = totals.get(key) ?? { connectionId, model, inputTokens: 0, outputTokens: 0 };
    entry.inputTokens += input;
    entry.outputTokens += output;
    totals.set(key, entry);
  };
  for (const message of document.messages) {
    if (message.usage) {
      add(
        message.usage.connectionId,
        message.usage.model,
        message.usage.inputTokens,
        message.usage.outputTokens,
      );
    }
  }
  for (const record of document.compaction?.history ?? []) {
    if (record.inputTokens === undefined && record.outputTokens === undefined) continue;
    add(
      record.model.connectionId,
      record.model.modelId,
      record.inputTokens ?? 0,
      record.outputTokens ?? 0,
    );
  }
  for (const test of document.tests) {
    for (const evidence of test.evidence) {
      if (evidence.promptTokens === undefined && evidence.completionTokens === undefined) continue;
      add(
        evidence.connectionId,
        evidence.model,
        evidence.promptTokens ?? 0,
        evidence.completionTokens ?? 0,
      );
    }
  }
  return [...totals.values()];
}

export interface Price {
  prompt: number;
  completion: number;
}

/** Dollars, from the catalogue's per-token prices; null when no recorded model has a price. */
export function spendCost(
  spend: readonly Spend[],
  priceOf: (entry: Spend) => Price | null,
): { usd: number; complete: boolean } | null {
  let usd = 0;
  let priced = 0;
  for (const entry of spend) {
    const price = priceOf(entry);
    if (!price) continue;
    priced += 1;
    usd += entry.inputTokens * price.prompt + entry.outputTokens * price.completion;
  }
  return priced ? { usd, complete: priced === spend.length } : null;
}

/** What one more reply like this one would cost, from what it used. */
export function replyCost(evidence: PresetTestEvidence | null, price: Price | null): number | null {
  if (!evidence || !price) return null;
  const input = evidence.promptTokens ?? evidence.totalTokens;
  const output = evidence.completionTokens;
  if (!input || output === undefined) return null;
  return input * price.prompt + output * price.completion;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ---------- Sessions ----------

export interface SessionGroup {
  key: string;
  name: string;
  sessions: PresetCocreatorSessionSummary[];
}

/** Sessions by the preset they work on, the most recently touched group first. */
export function groupSessions(
  sessions: readonly PresetCocreatorSessionSummary[],
  presets: readonly PresetSummary[],
): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  const sorted = [...sessions].sort((a, b) => b.modified - a.modified);
  for (const session of sorted) {
    const id = session.targetPresetId ?? session.sourcePresetId;
    const key = id ?? '\u0000default';
    const name = id
      ? (presets.find((preset) => preset.id === id)?.name ?? id.replace(/\.json$/i, ''))
      : 'The built-in default';
    const group = groups.get(key) ?? { key, name, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()];
}
