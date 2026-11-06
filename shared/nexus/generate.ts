import { createDefaultPreset } from '../prompt/defaults.ts';
import type { StreamState } from '../providers/sse.ts';
import type { Preset } from '../types/preset.ts';
import type { NexusSettings } from './types.ts';

/**
 * The synthetic preset every Nexus model call runs on. Nexus deliberately shares nothing
 * with the chat preset — its own samplers, budgets and reasoning effort — so a creative
 * chat configuration can never leak into a task that has to return validated JSON.
 *
 * `reasoning_effort` is Low by default to keep thinking (and its bill) modest. No reply cap
 * is sent (the preset is unlimited), so thinking can never starve the JSON; `outputTokens`
 * is only the room kept free for it while packing. Auto resolves to "send nothing" for
 * endpoints that reject the field.
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

/** What `nexusRequestError` needs from a finished generation. */
export type NexusRequestResult = Pick<
  StreamState,
  'finishReason' | 'content' | 'reasoning' | 'usage'
>;

/**
 * Why a Nexus model call produced nothing usable, or null when it did.
 *
 * Nexus sends no reply cap, so a length cut means the model hit its own output ceiling or
 * the context filled. With no text and some reasoning (counted reasoning tokens or reasoning
 * text, since not every provider reports the details object), the thinking used it all up.
 */
export function nexusRequestError(result: NexusRequestResult): string | null {
  if (result.finishReason === 'length') {
    const reasoned = result.reasoning.trim() !== '' || (result.usage?.reasoning_tokens ?? 0) > 0;
    if (!result.content.trim() && reasoned)
      return 'The memory model reasoned through its entire token budget and produced no memories. Lower the reasoning effort in Nexus settings, or choose a non-reasoning model.';
    return "The memory model's reply was cut off before the JSON finished. Retry, or raise the memory model's context if it is set lower than the model's real one.";
  }
  if (!result.content.trim()) return 'The memory model returned no content.';
  return null;
}
