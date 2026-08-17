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
export function normalizeBase(baseUrl: string): string {
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

/**
 * An Anthropic model on OpenRouter, matched by id prefix.
 *
 * OpenRouter namespaces every Anthropic model as `anthropic/claude-…`. The id is the only
 * signal available: this module is pure so the browser can build the exact payload, and the
 * model catalogue lives in a component's state, not here. SillyTavern matches on the model id
 * for the same reason.
 */
export function isAnthropicModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith('anthropic/');
}

/**
 * Share of the reply budget each effort spends on thinking. SillyTavern's ratios verbatim
 * (`calculateClaudeBudgetTokens`), so a preset means the same thing in both apps. `min` is the
 * floor itself, which is why its ratio is zero rather than a fraction.
 */
const CLAUDE_BUDGET_RATIO: Record<string, number> = {
  min: 0,
  low: 0.1,
  medium: 0.25,
  high: 0.5,
  max: 0.95,
};

/** Anthropic rejects a thinking budget below this. */
const CLAUDE_MIN_BUDGET = 1024;
/** OpenRouter's ceiling on the Anthropic thinking budget. */
const CLAUDE_MAX_BUDGET = 128000;
/** Anthropic requires streaming past this, so a blocking request cannot ask for more. */
const CLAUDE_MAX_BUDGET_BLOCKING = 21333;

/**
 * The thinking budget to buy for a Claude model, or null to leave thinking off.
 *
 * `auto` returns null and Claude simply does not think — Anthropic's own default. That keeps
 * the effort selector honest as an on/off switch: nobody starts paying for thinking they did
 * not ask for, and the "auto sends nothing" rule holds on this path too.
 */
export function claudeThinkingBudget(
  responseTokens: number,
  preset: Preset,
  stream: boolean,
): number | null {
  const effort = preset.reasoning_effort;
  if (!effort || effort === 'auto') return null;

  const ratio = CLAUDE_BUDGET_RATIO[effort];
  if (ratio === undefined) return null;

  const budget = Math.max(Math.floor(responseTokens * ratio), CLAUDE_MIN_BUDGET);
  return Math.min(budget, stream ? CLAUDE_MAX_BUDGET : CLAUDE_MAX_BUDGET_BLOCKING);
}

/** Samplers Anthropic will not take once thinking is on. The last three it never took. */
const CLAUDE_THINKING_CONFLICTS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'repetition_penalty',
];

export function buildRequestBody(request: GenerationRequest): ChatCompletionBody {
  const { messages, preset, connection, stream } = request;
  const descriptor = PROVIDERS[connection.provider];

  // Named rather than inlined: the Claude thinking budget below is sized from the reply
  // budget and then added to it, so both have to read the same number.
  const responseTokens = request.maxTokens ?? preset.openai_max_tokens ?? 300;

  const body: ChatCompletionBody = {
    model: connection.model,
    messages,
    stream,
    temperature: preset.temperature ?? 1,
    top_p: preset.top_p ?? 1,
    frequency_penalty: preset.frequency_penalty ?? 0,
    presence_penalty: preset.presence_penalty ?? 0,
    max_tokens: responseTokens,
  };

  // Absent, not empty. An empty array is a validation error on several backends.
  if (request.stop?.length) body.stop = request.stop;

  // Zero is a real seed; -1 is SillyTavern's "unset" sentinel.
  const seed = preset.seed;
  if (typeof seed === 'number' && seed >= 0) body.seed = seed;

  // Multi-choice completion. Extra completions come back as extra swipes, so the number
  // asked for is the caller's `completions`, never `preset.n` read from here: a summary
  // runs on the user's preset and must keep asking for exactly one.
  //
  // 1 sends nothing rather than `n: 1`. The default is universal, and a plain endpoint
  // that rejects unknown keys should not meet one it never needed.
  const completions = request.completions;
  if (typeof completions === 'number' && completions > 1) {
    body.n = Math.floor(completions);
  }

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

    // Anthropic ignores a bare `{exclude}` and no longer honours the `:thinking` suffix — an
    // explicit budget is the only switch. We size it here rather than sending `effort`, which
    // OpenRouter would turn into a budget we cannot see: `max_tokens` has to clear that number,
    // so guessing at their ratios would be the only alternative.
    const claudeBudget = isAnthropicModel(connection.model)
      ? claudeThinkingBudget(responseTokens, preset, stream)
      : null;

    if (claudeBudget !== null) {
      reasoning.max_tokens = claudeBudget;
      // On top of the reply rather than carved out of it: the reply keeps the length the user
      // asked for, and `max_tokens` clears the budget by construction.
      body.max_tokens = responseTokens + claudeBudget;
      // Anthropic rejects temperature/top_p/top_k alongside thinking, and the other three it
      // never accepted at all. Deleted here, after the sampler block above has written them.
      for (const key of CLAUDE_THINKING_CONFLICTS) delete body[key];
    } else if (reasoningEffort) {
      reasoning.effort = reasoningEffort;
    }

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
