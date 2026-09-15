import { createDefaultPreset } from '../prompt/defaults.ts';
import type { StreamState } from '../providers/sse.ts';
import { thinkingMaxTokens } from '../providers/thinking.ts';
import type { ConnectionSettings } from '../providers/types.ts';
import type { Preset } from '../types/preset.ts';
import type { NexusSettings } from './types.ts';

/**
 * The synthetic preset every Nexus model call runs on. Nexus deliberately shares nothing
 * with the chat preset — its own samplers, budgets and reasoning effort — so a creative
 * chat configuration can never leak into a task that has to return validated JSON.
 *
 * `reasoning_effort` is Low by default to keep thinking (and its bill) modest; the JSON
 * itself no longer starves, because `nexusMaxTokens` budgets thinking on top of the
 * output allowance. Auto resolves to "send nothing" for endpoints that reject the field.
 */
export function nexusPreset(settings: NexusSettings): Preset {
  const preset = createDefaultPreset();
  preset.temperature = settings.temperature;
  preset.openai_max_context = settings.inputTokens;
  preset.openai_max_tokens = settings.outputTokens;
  preset.reasoning_effort = settings.reasoningEffort;
  preset.top_p = 1;
  preset.presence_penalty = 0;
  preset.frequency_penalty = 0;
  preset.stream_openai = false;
  return preset;
}

/**
 * The `max_tokens` a Nexus request asks for: the visible-JSON allowance plus thinking room,
 * so reasoning is never carved out of the output. Shared with the group director, which
 * needs the same protection for its speaker pick.
 */
export function nexusMaxTokens(
  settings: NexusSettings,
  connection: Pick<ConnectionSettings, 'provider' | 'model'> | null,
): number {
  return thinkingMaxTokens({
    outputTokens: settings.outputTokens,
    contextTokens: settings.inputTokens,
    effort: settings.reasoningEffort,
    connection,
  });
}

/** What `nexusRequestError` needs from a finished generation. */
export type NexusRequestResult = Pick<
  StreamState,
  'finishReason' | 'content' | 'reasoning' | 'usage'
>;

/**
 * Why a Nexus model call produced nothing usable, or null when it did.
 *
 * A length cut with text is a real truncation of the JSON. A length cut with *no* text is
 * the reasoning-model failure: the whole completion budget — output allowance plus thinking
 * room — went to thinking (proved either by counted reasoning tokens or by reasoning text,
 * since not every provider reports the details object), and "increase the allowance" would
 * be advice the field's cap makes unachievable — the answer is less reasoning, not more
 * tokens.
 */
export function nexusRequestError(result: NexusRequestResult): string | null {
  if (result.finishReason === 'length') {
    const reasoned = result.reasoning.trim() !== '' || (result.usage?.reasoning_tokens ?? 0) > 0;
    if (!result.content.trim() && reasoned)
      return 'The memory model reasoned through its entire token budget and produced no memories. Lower the reasoning effort in Nexus settings, or choose a non-reasoning model.';
    return 'The memory model reached its output limit. Increase the Nexus output allowance and retry.';
  }
  if (!result.content.trim()) return 'The memory model returned no content.';
  return null;
}
