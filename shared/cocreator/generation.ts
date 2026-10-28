import { buildRequestBody } from '../providers/request.ts';
import { thinkingMaxTokens } from '../providers/thinking.ts';
import type { Connection } from '../providers/types.ts';
import type { Preset } from '../types/preset.ts';

export const COCREATOR_OUTPUT_TOKENS = 8192;
export const COCREATOR_CONTEXT_TOKENS = 131072;
export const CONTINUE_DESIGN_REPLY =
  'Continue your interrupted answer exactly where it stopped. Do not repeat the existing text. ' +
  'If it stopped inside a card block, finish that block and its closing fence before proceeding.';

/** Both desks budget visible output separately from reasoning and chat sampler presets. */
export function cocreatorBudget(options: {
  preset: Preset;
  connection: Connection;
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
      'Co-Creator context size must leave room for the reply and its prompt. Raise the context size or lower the output limit in setup.',
    );
  }
  const maxTokens = thinkingMaxTokens({
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
      maxTokens,
    }).max_tokens,
  );
  return {
    outputTokens,
    maxTokens,
    reservedTokens,
    promptTokens: contextTokens - reservedTokens - 128,
  };
}
