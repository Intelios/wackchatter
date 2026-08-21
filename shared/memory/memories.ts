/**
 * Operations on a chat's memory list.
 *
 * Pure and id-based throughout. Every function that has to reason about *where* a memory
 * sits in the transcript takes the transcript and resolves ids to positions itself, rather
 * than storing positions — a stored index is wrong the moment a message above it is
 * deleted, and silently wrong, which is worse.
 */

import type { Memory } from '../types/chat.ts';
import type { DraftMemory } from './extract.ts';

/**
 * Only identity and order are ever needed, so these take the narrowest possible view of a
 * transcript. That lets the client's `MessageState[]` be passed straight in without a
 * conversion whose only purpose would be to satisfy a type.
 */
export type TranscriptPositions = readonly { id: string }[];

/**
 * Every message id a memory covers, inclusive at both ends.
 *
 * Empty when either endpoint has been deleted: a range whose bounds no longer exist cannot
 * be resolved, and guessing at it would hide or reveal the wrong messages. `stale` is how
 * that state is surfaced instead.
 */
export function coveredMessageIds(memory: Memory, messages: TranscriptPositions): string[] {
  if (!memory.range) return [];
  const start = messages.findIndex((message) => message.id === memory.range!.startId);
  const end = messages.findIndex((message) => message.id === memory.range!.endId);
  if (start === -1 || end === -1 || end < start) return [];
  return messages.slice(start, end + 1).map((message) => message.id);
}

/**
 * The ids a memory may hide: its range, minus the verbatim tail.
 *
 * The tail is enforced here rather than during extraction on purpose. Memories should
 * still be written about recent turns — that is how the chain stays continuous — but the
 * recent prose itself stays word-for-word, because compressing it is the one step that
 * cannot be undone by reading the cards.
 */
export function hideableMessageIds(
  memory: Memory,
  messages: TranscriptPositions,
  verbatimTail: number,
): string[] {
  const covered = coveredMessageIds(memory, messages);
  if (covered.length === 0) return [];
  const cutoff = messages.length - Math.max(0, Math.floor(verbatimTail));
  if (cutoff <= 0) return [];
  const protectedIds = new Set(messages.slice(cutoff).map((message) => message.id));
  return covered.filter((id) => !protectedIds.has(id));
}

export interface DraftToMemoryOptions {
  model?: string;
  now?: number;
  /** Injected so tests are deterministic. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

/** Turn parsed drafts into stored memories. Newly written memories start unpinned and live. */
export function draftsToMemories(
  drafts: DraftMemory[],
  options: DraftToMemoryOptions = {},
): Memory[] {
  const { model, now = Date.now(), newId = () => crypto.randomUUID() } = options;
  return drafts.map((draft) => ({
    id: newId(),
    title: draft.title,
    text: draft.text,
    keywords: draft.keywords,
    quotes: draft.quotes.length ? draft.quotes : undefined,
    range: { startId: draft.startId, endId: draft.endId },
    pinned: false,
    enabled: true,
    source: 'generated' as const,
    edited: false,
    generatedAt: now,
    model,
  }));
}

/**
 * Mark every memory covering `messageId` as stale.
 *
 * Must run BEFORE the message is removed, since containment is resolved against the live
 * transcript. Returns null when nothing changed, so a caller can skip a pointless revision.
 *
 * Nothing is auto-corrected. A memory quietly describing text that no longer exists is the
 * failure every comparable extension documents; silently rewriting one someone had edited
 * by hand would be a worse one.
 */
export function markMemoriesStale(
  memories: Memory[],
  messages: TranscriptPositions,
  messageId: string,
  reason: 'edited' | 'deleted',
): Memory[] | null {
  const position = messages.findIndex((message) => message.id === messageId);
  if (position === -1) return null;

  let changed = false;
  const next = memories.map((memory) => {
    if (memory.stale === reason || !memory.range) return memory;
    const start = messages.findIndex((message) => message.id === memory.range!.startId);
    const end = messages.findIndex((message) => message.id === memory.range!.endId);
    if (start === -1 || end === -1 || position < start || position > end) return memory;
    changed = true;
    return { ...memory, stale: reason };
  });

  return changed ? next : null;
}

/**
 * The watermark after a run: the end of the last memory written.
 *
 * Falls back to the existing watermark when a window produced nothing, which is what stops
 * a run advancing past material it never actually recorded.
 */
export function nextWatermark(written: Memory[], current?: string): string | undefined {
  return written.at(-1)?.range?.endId ?? current;
}
