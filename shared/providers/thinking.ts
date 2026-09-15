/**
 * Thinking room bought on top of an output allowance.
 *
 * OpenAI-compatible endpoints count reasoning inside `max_tokens`, so a model that thinks
 * at all spends the JSON's budget before writing any of it — a 10K-token think is not
 * output. Callers that need a visible, parseable answer (the Nexus extraction contract, the
 * group director's speaker pick) ask for their output allowance plus this room, so the
 * answer is never carved out of the thinking.
 *
 * `auto` buys the same room as Low: it sends no effort field, but an endpoint's default
 * effort is not "never think".
 */

import type { ReasoningEffort } from '../types/preset.ts';
import { isAnthropicModel } from './request.ts';
import type { ConnectionSettings } from './types.ts';

export const THINKING_HEADROOM: Record<ReasoningEffort, number> = {
  auto: 8192,
  min: 4096,
  low: 8192,
  medium: 16384,
  high: 32768,
  max: 65536,
};

/** Slop left between a packed prompt and the declared context. */
const CONTEXT_SLOP = 128;

/**
 * The `max_tokens` to ask for: the visible-output allowance plus thinking room, clamped to
 * the declared context's slack (context − output − slop) so the ask stays within what the
 * user said the model has. A context with no slack still asks for the full reply budget —
 * the one thing the request exists to produce.
 *
 * Claude on OpenRouter is the exception: `buildRequestBody` sizes an exact thinking budget
 * and adds it on top of whatever it is given, so there the reply budget travels alone.
 */
export function thinkingMaxTokens(options: {
  outputTokens: number;
  contextTokens: number;
  effort: ReasoningEffort;
  connection: Pick<ConnectionSettings, 'provider' | 'model'> | null;
}): number {
  if (options.connection?.provider === 'openrouter' && isAnthropicModel(options.connection.model))
    return options.outputTokens;
  const slack = Math.max(0, options.contextTokens - options.outputTokens - CONTEXT_SLOP);
  const headroom = Math.min(THINKING_HEADROOM[options.effort], slack);
  return options.outputTokens + headroom;
}
