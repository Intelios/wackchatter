/**
 * What the classic summary covers, by fingerprint: which messages it already holds, which
 * are new, and which it summarised but have changed since. Pure, so the rules are tested.
 *
 * Fingerprints are content (`messageFingerprint`: speaker, persona and text), not ids. An
 * edited message or a newly picked swipe reads as changed rather than covered, and deleting
 * a message never loses the summary its place, which an id checkpoint did.
 */

import { messageFingerprint } from '@shared/nexus/state.ts';
import type { ChatMessage, StorySummary, StorySummaryVersion } from '@shared/types/chat.ts';

/** The stamp on a message the summary hid, so a rewrite can still read it. */
export const SUMMARY_HIDDEN = 'summary';

/** How many earlier versions a summary keeps for undo. */
export const SUMMARY_HISTORY = 5;

/**
 * The messages a summary is written from: non-blank turns in order. Hidden ones are left
 * out (someone took them out of the story) unless the summary itself hid them.
 */
export function summarisable(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (!message.mes.trim()) return [];
    if (message.is_system && message.hiddenBy !== SUMMARY_HIDDEN) return [];
    return [{ ...message, mes: message.mes.trim() }];
  });
}

export interface Coverage {
  /** Messages after the last one the summary covers: what an update sends. */
  backlog: ChatMessage[];
  /** Covered ground that has changed since: edited, re-swiped, or added in between. */
  changed: number;
  /** How many of the chat's messages the summary holds. */
  covered: number;
  /** The fingerprints the summary covers, resolved for a summary from before them. */
  fingerprints: string[];
}

/** Where a summary stands against the chat now. */
export function summaryCoverage(
  messages: readonly ChatMessage[],
  summary: StorySummary | undefined,
): Coverage {
  const fingerprints = coveredFingerprints(messages, summary);
  const set = new Set(fingerprints);
  let last = -1;
  const prints = messages.map(messageFingerprint);
  prints.forEach((print, index) => {
    if (set.has(print)) last = index;
  });
  let changed = 0;
  for (let index = 0; index <= last; index++) {
    if (!set.has(prints[index] as string)) changed++;
  }
  return {
    backlog: messages.slice(last + 1),
    changed,
    covered: last + 1 - changed,
    fingerprints,
  };
}

/**
 * The fingerprints a summary covers. One written before fingerprints names only the last
 * message it reached; everything up to that message is taken as covered.
 */
function coveredFingerprints(
  messages: readonly ChatMessage[],
  summary: StorySummary | undefined,
): string[] {
  if (!summary?.text.trim()) return [];
  if (summary.covered) return summary.covered;
  if (!summary.checkpointMessageId) return [];
  const index = messages.findIndex((message) => message.id === summary.checkpointMessageId);
  return index === -1 ? [] : messages.slice(0, index + 1).map(messageFingerprint);
}

/** The summary after writing `text` over `messages`, on top of `covered` from before. */
export function writtenSummary(
  previous: StorySummary | undefined,
  text: string,
  covered: readonly string[],
  messages: readonly ChatMessage[],
  now: Date,
): StorySummary {
  const seen = new Set(covered);
  const next = [...covered];
  for (const message of messages) {
    const print = messageFingerprint(message);
    if (!seen.has(print)) {
      seen.add(print);
      next.push(print);
    }
  }
  return {
    text,
    covered: next,
    updatedAt: now.toISOString(),
    ...(previous?.history ? { history: previous.history } : {}),
  };
}

/** Put the summary as it stands into history, before a run replaces it. */
export function withHistory(summary: StorySummary | undefined): StorySummary | undefined {
  if (!summary?.text.trim()) return summary;
  const version: StorySummaryVersion = {
    text: summary.text,
    ...(summary.covered ? { covered: summary.covered } : {}),
    ...(summary.checkpointMessageId ? { checkpointMessageId: summary.checkpointMessageId } : {}),
    ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
  };
  return {
    ...summary,
    history: [version, ...(summary.history ?? [])].slice(0, SUMMARY_HISTORY),
  };
}

/** Undo: the newest earlier version comes back, with what it covered. */
export function undoneSummary(summary: StorySummary | undefined): StorySummary | null {
  const [previous, ...rest] = summary?.history ?? [];
  if (!previous) return null;
  return { ...previous, ...(rest.length ? { history: rest } : {}) };
}

/**
 * Bring back an earlier version: it becomes the summary, and the one it replaces goes into
 * history, so a restore can itself be undone.
 */
export function restoredSummary(
  summary: StorySummary | undefined,
  index: number,
): StorySummary | null {
  const version = summary?.history?.[index];
  if (!summary || !version) return null;
  const rest = summary.history?.filter((_, at) => at !== index) ?? [];
  const kept = withHistory({ ...summary, history: rest });
  return { ...version, ...(kept?.history?.length ? { history: kept.history } : {}) };
}

/**
 * Which messages to hide once they are summarised: every covered one that is still in the
 * prompt, except the newest `keep` of the chat, which stay for continuity.
 */
export function messagesToHide(
  messages: readonly ChatMessage[],
  covered: readonly string[],
  keep: number,
): string[] {
  const set = new Set(covered);
  const visible = messages.filter((message) => !message.is_system && message.mes.trim());
  const kept = new Set(visible.slice(Math.max(0, visible.length - keep)).map((m) => m.id));
  return visible
    .filter(
      (message) =>
        !kept.has(message.id) &&
        set.has(messageFingerprint({ ...message, mes: message.mes.trim() })),
    )
    .map((message) => message.id);
}
