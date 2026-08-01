/**
 * Token counting.
 *
 * `assemblePrompt` takes a synchronous `(text: string) => number`, so the encoding is
 * loaded asynchronously and then counted synchronously. gpt-tokenizer counts 40,000
 * tokens in about 9ms cold, and `memoizeCounter` means a re-assembly only pays for text
 * that actually changed — so a worker would buy very little and cost the entire engine
 * signature, which every caller and the Prompt Manager's live counts depend on.
 *
 * Accuracy is exact for GPT and o-series models and an estimate for everything else,
 * which is the same position SillyTavern is in.
 */

import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ApiMessage } from '@shared/types/chat.ts';

export type EncodingName = 'o200k_base' | 'cl100k_base';

/** Roughly 4 characters per token, biased high so the budget is never overrun. */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

/** Conservative ChatML-style estimate while the real encoding is loading. */
export function approximateChatTokens(messages: readonly ApiMessage[]): number {
  // gpt-tokenizer's chat helper charges 3 per message, 1 extra for a name, and 3 for
  // reply priming. Count role and name text too, not just visible content.
  return (
    3 +
    messages.reduce((total, message) => {
      const name = message.name ? approximateTokens(message.name) + 1 : 0;
      return (
        total + 3 + approximateTokens(message.role) + approximateTokens(message.content) + name
      );
    }, 0)
  );
}

/**
 * Pick an encoding from a model id.
 *
 * OpenRouter ids are `vendor/model`, so the vendor prefix is stripped first. Anything
 * that isn't a recognised OpenAI model falls back to cl100k — an approximation for
 * Claude, Llama and Mistral, and the same compromise ST makes.
 */
export function encodingForModel(model: string, override?: string): EncodingName {
  if (override === 'o200k_base' || override === 'cl100k_base') return override;

  const id = model.toLowerCase().split('/').pop() ?? '';

  if (
    id.startsWith('gpt-4o') ||
    id.startsWith('gpt-4.1') ||
    id.startsWith('gpt-4.5') ||
    id.startsWith('gpt-5') ||
    /^o[1-9]($|[-.])/.test(id)
  ) {
    return 'o200k_base';
  }

  return 'cl100k_base';
}

const loaded = new Map<EncodingName, TokenCounter>();

/**
 * Load an encoding, caching it. Each is a large table, so they are imported on demand
 * rather than bundled together.
 */
export async function loadCounter(encoding: EncodingName): Promise<TokenCounter> {
  const cached = loaded.get(encoding);
  if (cached) return cached;

  const module =
    encoding === 'o200k_base'
      ? await import('gpt-tokenizer/encoding/o200k_base')
      : await import('gpt-tokenizer/encoding/cl100k_base');

  const counter: TokenCounter = {
    countText: (text) => module.countTokens(text),
    countChat: (messages) => module.countTokens(messages),
  };
  loaded.set(encoding, counter);
  return counter;
}

/** Whether an encoding is already resident, so callers can skip the loading state. */
export function isCounterLoaded(encoding: EncodingName): boolean {
  return loaded.has(encoding);
}
