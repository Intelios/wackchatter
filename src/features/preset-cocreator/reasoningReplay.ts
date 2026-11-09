import { normalizeBase } from '@shared/providers/request.ts';
import {
  PROVIDER_REASONING_FIELDS,
  type ProviderReasoningFields,
  type ProviderToolCall,
  type ResolvedModel,
} from '@shared/providers/types.ts';
import type { PresetCocreatorMessage } from '@shared/types/preset-cocreator.ts';

export type AssistantProviderState = ProviderReasoningFields & {
  tool_calls?: ProviderToolCall[];
  reasoning_details?: unknown[];
  extra_content?: Record<string, unknown>;
};

function sameSource(message: PresetCocreatorMessage, target: ResolvedModel): boolean | undefined {
  const source = message.providerSource;
  if (source) {
    return (
      source.connectionId === target.id &&
      source.modelId === target.model &&
      source.provider === target.provider &&
      normalizeBase(source.baseUrl) === normalizeBase(target.baseUrl)
    );
  }
  // Older sessions recorded an origin only when the endpoint supplied token usage.
  if (message.usage)
    return message.usage.connectionId === target.id && message.usage.model === target.model;
  return undefined;
}

/** DeepSeek requires this field on assistant history when tools are present, even if empty. */
function requiresReasoningContent(target: ResolvedModel | undefined): boolean {
  if (target?.provider !== 'custom') return false;
  try {
    return new URL(target.baseUrl).hostname === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** Only explicit API state is replayed, to its own source. Never turn display tags into state. */
export function replayAssistantProviderState(
  message: PresetCocreatorMessage,
  target?: ResolvedModel,
): AssistantProviderState {
  const matching = target ? sameSource(message, target) : true;
  const keepOpaque = matching !== false && !message.incomplete;
  const result: AssistantProviderState = {};
  if (message.toolCalls?.length) {
    result.tool_calls = structuredClone(message.toolCalls);
    if (!keepOpaque) {
      for (const call of result.tool_calls) delete call.extra_content;
    }
  }
  if (keepOpaque && message.extraContent)
    result.extra_content = structuredClone(message.extraContent);
  if (keepOpaque && message.reasoningDetails?.length) {
    // The structured representation already carries the thought; its raw text mirror would
    // duplicate it and can lose the signature contract on OpenRouter.
    result.reasoning_details = structuredClone(message.reasoningDetails);
  } else if (matching === true && !message.incomplete && message.reasoningFields) {
    const fields =
      target?.provider === 'openrouter'
        ? (['reasoning', 'reasoning_content', 'reasoning_text'] as const)
        : PROVIDER_REASONING_FIELDS;
    for (const field of fields) {
      const text = message.reasoningFields[field];
      if (typeof text !== 'string') continue;
      result[field] = text;
      break;
    }
  }
  if (
    requiresReasoningContent(target) &&
    !result.reasoning_details &&
    result.reasoning_content === undefined
  ) {
    // A legacy reply with a known DeepSeek origin has recoverable explicit reasoning.
    // Unknown/different origins get an empty field, never another model's thought text.
    result.reasoning_content =
      matching === true && !message.incomplete && !message.reasoningFields
        ? (message.reasoning ?? '')
        : '';
  }
  return result;
}
