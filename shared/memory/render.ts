/**
 * Turning a `Memory` into the text the model actually reads.
 *
 * Deliberately free of any mention of messages, hiding, indices or summarisation. The
 * model is being told what happened in the story, not how the app is managing its context
 * window; a memory that says "messages 1-40 were summarised" invites the model to talk
 * about the app instead of the story, and it is the one thing every comparable extension
 * warns about.
 */

import type { Memory } from '../types/chat.ts';

/** One memory, as a titled block. Quotes follow the description, one per line. */
export function renderMemory(memory: Memory): string {
  const lines = [`## ${memory.title.trim()}`, memory.text.trim()];
  for (const quote of memory.quotes ?? []) {
    const clean = quote.trim();
    if (clean) lines.push(`"${clean.replace(/^"|"$/g, '')}"`);
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Several memories as one block, oldest first.
 *
 * Chronological rather than by relevance: these are events in a story, and a model shown
 * "The Bargain" before "First Meeting" will infer that order is meaningful and write the
 * relationship backwards.
 */
export function renderMemories(memories: Memory[]): string {
  return memories.map(renderMemory).filter(Boolean).join('\n\n');
}

/**
 * Prior memories as context for the next extraction call.
 *
 * Title and text only — no quotes, no keywords. This exists so memory N+1 does not
 * reintroduce a character the reader already met as "a woman he encounters"; it is not
 * there for the extractor to mine for detail, and the smaller it is the less likely the
 * extractor is to pad a new memory with old material.
 */
export function renderMemoryChain(memories: Memory[]): string {
  return memories
    .map((memory) => `${memory.title.trim()}: ${memory.text.trim()}`)
    .filter((line) => line.length > 2)
    .join('\n');
}
