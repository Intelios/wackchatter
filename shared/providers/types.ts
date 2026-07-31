/**
 * Provider definitions.
 *
 * Two providers only: a generic OpenAI-compatible endpoint and OpenRouter. SillyTavern
 * carries around twenty-six, and the difference between them is almost entirely which
 * subset of samplers each accepts — a table, not a code path per provider.
 *
 * Connection settings live in our own settings.json, never in a preset. A preset's own
 * connection keys (custom_url, openrouter_model, chat_completion_source) round-trip
 * untouched but are never read, so switching preset changes prompts and samplers without
 * silently repointing you at a different server.
 */

import type { ApiMessage } from '../types/chat.ts';
import type { Preset } from '../types/preset.ts';

export type ProviderId = 'custom' | 'openrouter';

/** OpenRouter's provider-routing preferences. */
export interface OpenRouterRouting {
  /** Provider names in preference order. Sent as `provider.order`. */
  order?: string[];
  /** Whether OpenRouter may fall back outside `order`. Nested inside `provider`. */
  allow_fallbacks?: boolean;
  quantizations?: string[];
  /** Allow middle-out transform when the prompt exceeds the model's context. */
  middleOut?: boolean;
}

export interface ConnectionSettings {
  provider: ProviderId;
  /** Base URL with no trailing slash and no /chat/completions suffix. */
  baseUrl: string;
  model: string;
  routing?: OpenRouterRouting;
  /** Extra headers the user configured. Merged last, so they can override ours. */
  headers?: Record<string, string>;
  /**
   * Ask the provider to report real token usage. Off by default for `custom`: some
   * OpenAI-compatible proxies reject unknown top-level keys, the same way they reject
   * an empty `stop` array.
   */
  reportUsage?: boolean;
  /** Request reasoning/thinking text from models that produce it. */
  showReasoning?: boolean;
}

export interface GenerationRequest {
  messages: ApiMessage[];
  preset: Preset;
  connection: ConnectionSettings;
  stream: boolean;
  /** Overrides the preset's openai_max_tokens. */
  maxTokens?: number;
  stop?: string[];
}

/** The body posted to a chat-completions endpoint. Deliberately open — providers differ. */
export type ChatCompletionBody = Record<string, unknown>;

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string;
  /** Whether top_k / min_p / top_a / repetition_penalty may be sent. */
  supportsExtraSamplers: boolean;
  supportsRouting: boolean;
  /** Whether the endpoint exposes a listable model catalogue. */
  supportsModelList: boolean;
  requiresKey: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  custom: {
    id: 'custom',
    label: 'OpenAI-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsExtraSamplers: false,
    supportsRouting: false,
    supportsModelList: true,
    // Local servers (llama.cpp, KoboldCpp, LM Studio) take no key at all.
    requiresKey: false,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    supportsExtraSamplers: true,
    supportsRouting: true,
    supportsModelList: true,
    requiresKey: true,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && value in PROVIDERS;
}

/** A model as offered by the provider's /models endpoint. */
export interface ProviderModel {
  id: string;
  name: string;
  contextLength?: number;
  /** USD per token, as OpenRouter reports it. */
  promptPrice?: number;
  completionPrice?: number;
}

export const DEFAULT_CONNECTION: ConnectionSettings = {
  provider: 'custom',
  baseUrl: PROVIDERS.custom.defaultBaseUrl,
  model: '',
  showReasoning: true,
};
