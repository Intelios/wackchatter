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

/** Per-message costing with the whole-chat reply priming separated out. */
export interface MessageCoster {
  /** One message's tokens, excluding the priming every whole-chat count carries. */
  cost(message: ApiMessage): number;
  /** The priming itself, charged once against the assembled payload. */
  readonly replyPriming: number;
}

/**
 * Cost individual messages against a counter that prices whole chats.
 *
 * gpt-tokenizer includes completion priming in every `countChat`, so assigning a message to
 * a prompt slot has to subtract it and the final payload has to charge it once. Shared
 * rather than restated by each prompt builder: both `assemblePrompt` and the Co-Creator's
 * `buildDesignPrompt` need the identical accounting, and a divergence between them would
 * show up only as budgets that quietly disagree.
 */
export function messageCoster(counter: TokenCounter): MessageCoster {
  const replyPriming = counter.countChat([]);
  return {
    replyPriming,
    cost: (message) => counter.countChat([message]) - replyPriming,
  };
}

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

  const countText = (text: string) =>
    text ? cached(`text:${text}`, () => counter.countText(text)) : 0;

  return {
    countText,
    countChat: (messages) => {
      // Not a plain `return 0`: a whole-chat count of nothing is the reply priming the
      // counter charges on every call, and `messageCoster` subtracts exactly that. Cached
      // under a fixed key so the fast path still skips the stringify.
      if (messages.length === 0) return cached('chat:[]', () => counter.countChat([]));
      if (messages.length === 1) {
        const m = messages[0]!;
        return cached(`msg:${m.role}:${m.name ?? ''}:${m.content}`, () =>
          counter.countChat(messages),
        );
      }
      const materialized = [...messages];
      return cached(`chat:${JSON.stringify(materialized)}`, () => counter.countChat(materialized));
    },
  };
}
