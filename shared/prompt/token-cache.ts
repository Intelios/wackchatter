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

export type TokenCounter = (text: string) => number;

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

  return (text: string): number => {
    if (!text) return 0;

    const cached = cache.get(text);
    if (cached !== undefined) {
      // Re-insert to mark it as most recently used.
      cache.delete(text);
      cache.set(text, cached);
      return cached;
    }

    const count = counter(text);
    cache.set(text, count);

    if (cache.size > limit) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }

    return count;
  };
}
