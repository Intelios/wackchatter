/**
 * Building the outgoing chat-completion request.
 *
 * Pure on purpose: the API key arrives as a parameter and is never looked up here, so
 * this whole module is unit-testable and can be imported by the browser to produce the
 * exact object it will POST — which is what makes the prompt inspector show the real
 * payload rather than a reconstruction.
 *
 * Two rules are load-bearing and both came from watching SillyTavern work around real
 * backends:
 *  - An empty `stop` must be ABSENT, not `undefined` or `[]`. Several OpenAI-compatible
 *    servers 400 on an empty array.
 *  - `seed` is only sent when >= 0. Zero is a legitimate seed, so the guard cannot be
 *    a truthiness check.
 */

import type { Preset } from '../types/preset.ts';
import type {
  ChatCompletionBody,
  ConnectionSettings,
  GenerationRequest,
  ProviderModel,
} from './types.ts';
import { PROVIDERS } from './types.ts';

/** Strip trailing slashes so a user pasting ".../v1/" still works. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function completionsUrl(connection: ConnectionSettings): string {
  return `${normalizeBase(connection.baseUrl)}/chat/completions`;
}

export function modelsUrl(connection: ConnectionSettings): string {
  return `${normalizeBase(connection.baseUrl)}/models`;
}

/**
 * Headers for the upstream request.
 *
 * A null key produces NO Authorization header at all. Sending `Bearer null` makes
 * llama.cpp and KoboldCpp reject a request they would otherwise have served.
 */
export function buildHeaders(
  connection: ConnectionSettings,
  apiKey: string | null,
  appUrl: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  if (connection.provider === 'openrouter') {
    // OpenRouter attributes traffic with these and shows the title in its dashboard.
    headers['HTTP-Referer'] = appUrl;
    headers['X-Title'] = 'WackChatter';
  }

  // User-supplied headers win, so a proxy needing its own auth scheme can override.
  return { ...headers, ...connection.headers };
}

/** `min`/`max` are UI conveniences; the wire only knows low/medium/high. */
const REASONING_EFFORT_MAP: Record<string, string> = { min: 'low', max: 'high' };

/** `auto` (and absent) sends nothing — unsupported models must see an unchanged request. */
function resolveReasoningEffort(preset: Preset): string | undefined {
  const effort = preset.reasoning_effort;
  if (!effort || effort === 'auto') return undefined;
  return REASONING_EFFORT_MAP[effort] ?? effort;
}

export function buildRequestBody(request: GenerationRequest): ChatCompletionBody {
  const { messages, preset, connection, stream } = request;
  const descriptor = PROVIDERS[connection.provider];

  const body: ChatCompletionBody = {
    model: connection.model,
    messages,
    stream,
    temperature: preset.temperature ?? 1,
    top_p: preset.top_p ?? 1,
    frequency_penalty: preset.frequency_penalty ?? 0,
    presence_penalty: preset.presence_penalty ?? 0,
    max_tokens: request.maxTokens ?? preset.openai_max_tokens ?? 300,
  };

  // Absent, not empty. An empty array is a validation error on several backends.
  if (request.stop?.length) body.stop = request.stop;

  // Zero is a real seed; -1 is SillyTavern's "unset" sentinel.
  const seed = preset.seed;
  if (typeof seed === 'number' && seed >= 0) body.seed = seed;

  // WC-07: Multi-choice completion (`n > 1`) is not wired to any UI or storage. The
  // streaming and non-stream parsers read only `choices[0]`, so any extra completions
  // would be paid for and discarded — and taking the first array element in each chunk
  // is not a safe substitute for following a stable `choice.index`. Clamp to 1 until
  // multi-choice is intentionally implemented.

  if (descriptor.supportsExtraSamplers) {
    // These four are OpenRouter-only among OpenAI-compatible sources. A plain endpoint
    // that receives them may reject the whole request.
    body.top_k = preset.top_k ?? 0;
    body.min_p = preset.min_p ?? 0;
    body.top_a = preset.top_a ?? 0;
    body.repetition_penalty = preset.repetition_penalty ?? 1;
  }

  if (descriptor.supportsRouting) {
    const routing = connection.routing;

    if (routing?.order?.length || routing?.quantizations?.length) {
      const provider: Record<string, unknown> = {};
      if (routing.order?.length) {
        provider.order = routing.order;
        provider.allow_fallbacks = routing.allow_fallbacks ?? true;
      }
      if (routing.quantizations?.length) provider.quantizations = routing.quantizations;
      body.provider = provider;
    }

    if (routing?.middleOut) body.transforms = ['middle-out'];
  }

  const reasoningEffort = resolveReasoningEffort(preset);

  if (connection.provider === 'openrouter') {
    const reasoning: Record<string, unknown> = { exclude: connection.showReasoning === false };
    if (reasoningEffort) reasoning.effort = reasoningEffort;
    body.reasoning = reasoning;
    // OpenRouter's own usage flag. It does not accept OpenAI's stream_options.
    if (connection.reportUsage) body.usage = { include: true };
  } else {
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (connection.reportUsage && stream) body.stream_options = { include_usage: true };
  }

  return body;
}

/** Normalise a /models response. OpenRouter and OpenAI report the same envelope. */
export function parseModelList(payload: unknown): ProviderModel[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  return data
    .map((entry): ProviderModel | null => {
      if (!entry || typeof entry !== 'object') return null;
      const model = entry as Record<string, unknown>;
      const id = typeof model.id === 'string' ? model.id : null;
      if (!id) return null;

      const pricing = (model.pricing ?? {}) as Record<string, unknown>;
      const result: ProviderModel = {
        id,
        name: typeof model.name === 'string' ? model.name : id,
      };

      if (typeof model.context_length === 'number') result.contextLength = model.context_length;
      const prompt = Number(pricing.prompt);
      const completion = Number(pricing.completion);
      if (Number.isFinite(prompt)) result.promptPrice = prompt;
      if (Number.isFinite(completion)) result.completionPrice = completion;

      return result;
    })
    .filter((model): model is ProviderModel => model !== null);
}
