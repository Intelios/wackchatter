import { buildRequestBody } from '../providers/request.ts';
import { thinkingMaxTokens } from '../providers/thinking.ts';
import type { ResolvedModel } from '../providers/types.ts';
import type { Preset } from '../types/preset.ts';

export const COCREATOR_OUTPUT_TOKENS = 8192;
export const COCREATOR_CONTEXT_TOKENS = 131072;
export const CONTINUE_DESIGN_REPLY =
  'Continue your interrupted answer exactly where it stopped. Do not repeat the existing text. ' +
  'If it stopped inside a card block, finish that block and its closing fence before proceeding.';

/**
 * How much of the context both desks keep free for the reply, reasoning included, and what
 * that leaves for the prompt. Only a reserve: requests send no cap (`maxTokens: null`), so a
 * long card or a long think is never cut off. `outputTokens` is the visible-reply share of the
 * reserve; no longer shown in setup, a stored value still sizes it.
 */
export function cocreatorBudget(options: {
  preset: Preset;
  connection: ResolvedModel;
  outputTokens?: number;
  contextTokens?: number;
  stream?: boolean;
}) {
  const outputTokens = options.outputTokens ?? COCREATOR_OUTPUT_TOKENS;
  const contextTokens = options.contextTokens ?? COCREATOR_CONTEXT_TOKENS;
  if (
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 1 ||
    !Number.isSafeInteger(contextTokens) ||
    contextTokens <= outputTokens + 128
  ) {
    throw new Error(
      'Co-Creator context size must leave room for the reply and its prompt. Raise the context size in setup.',
    );
  }
  const replyTokens = thinkingMaxTokens({
    outputTokens,
    contextTokens,
    effort: options.preset.reasoning_effort ?? 'auto',
    connection: options.connection,
  });
  // Claude on OpenRouter adds thinking inside the request builder. Reserve that too.
  const reservedTokens = Number(
    buildRequestBody({
      messages: [],
      preset: options.preset,
      connection: options.connection,
      stream: options.stream ?? true,
      maxTokens: replyTokens,
    }).max_tokens,
  );
  return {
    outputTokens,
    reservedTokens,
    promptTokens: contextTokens - reservedTokens - 128,
  };
}
