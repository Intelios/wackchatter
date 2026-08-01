/**
 * A bounded memo around a token counter.
 *
 * This is what makes running a real BPE tokenizer on the main thread reasonable. The
 * Prompt Manager re-assembles the whole prompt whenever anything changes, but the message
 * texts themselves almost never change between assemblies — so with a memo the cost of a
 * re-count is proportional to the new text rather than to the whole context window.
 *
 * Measured with gpt-tokenizer: a 40,000-token string counts in ~9ms cold. Warm, an
 * assembly that added one message costs the tokens of that one message.
 */

import type { ApiMessage } from '../types/chat.ts';

/** Text is used by World Info; complete messages are used for provider-context budgets. */
export interface TokenCounter {
  countText(text: string): number;
  countChat(messages: readonly ApiMessage[]): number;
}

const DEFAULT_LIMIT = 2048;

/**
 * Wrap a counter in a least-recently-used cache.
 *
 * @param limit Maximum distinct strings retained. The default holds a long chat's worth
 *   of messages plus every prompt in a preset several times over.
 */
export function memoizeCounter(counter: TokenCounter, limit = DEFAULT_LIMIT): TokenCounter {
  // Map iterates in insertion order, so the first key is always the least recent.
  const cache = new Map<string, number>();

  function cached(key: string, count: () => number): number {
    const hit = cache.get(key);
    if (hit !== undefined) {
      // Re-insert to mark it as most recently used.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }

    const result = count();
    cache.set(key, result);
    if (cache.size > limit) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return result;
  }

  return {
    countText: (text) => (text ? cached(`text:${text}`, () => counter.countText(text)) : 0),
    countChat: (messages) => {
      const materialized = [...messages];
      return cached(`chat:${JSON.stringify(materialized)}`, () => counter.countChat(materialized));
    },
  };
}
