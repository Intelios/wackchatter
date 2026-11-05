/**
 * The generation service: the one way anything in the client asks a model for text.
 *
 * Every feature — chat, recap, summaries, Nexus, both Co-Creators, the Arena, persona
 * derive, preset testing — builds its own request body and hands it here with the model it
 * resolved (`shared/models/slots.ts`). What they used to repeat each in their own way lives
 * here once: posting to the proxy with the model's connection, reading the stream or the
 * single response, surfacing a provider error hidden in a 200, timing the first token, and
 * logging usage — including for a reply someone stopped, because that was still billed.
 *
 * `runGeneration` is the only export that reaches `/api/generate`; `generation.test.ts`
 * pins that no other client module does.
 */

import type { StreamState } from '@shared/providers/sse.ts';
import {
  createSseParser,
  createStreamAccumulator,
  parseCompletion,
} from '@shared/providers/sse.ts';
import type { ChatCompletionBody, ResolvedModel } from '@shared/providers/types.ts';
import type { UsageFeature, UsageReport } from '@shared/types/usage.ts';
import { type EncodingName, encodingForModel, loadCounter } from './tokenizer.ts';

/**
 * What a call site knows about its own generation that the transport cannot infer.
 *
 * Everything else — model, tokens, timings — is read off the request and response here,
 * so a new call site opts in by passing this and nothing more.
 */
export interface UsageMeta {
  feature: UsageFeature;
  /**
   * Identity for this generation, when the call site needs to persist it alongside what
   * the generation produced. Pass one from anywhere that writes a swipe: an interrupted
   * reply reaches storage through a path that never sees the response, so an id minted
   * in here could not reach it, and the same generation would be accounted for twice —
   * once from the log and once from the transcript.
   *
   * The transport mints one when this is absent, which is right for the call sites that
   * store nothing.
   */
  generationId?: string;
  /**
   * Stable chat, arena round, or design-workflow id. Also used for provider session routing:
   * re-rolls and auxiliary requests must keep it, rather than using a new generation id.
   */
  sessionId?: string;
  character?: string;
  /**
   * The call site's own token counter, when it has one.
   *
   * Passing it keeps the logged estimate byte-identical to whatever that call site
   * persisted alongside the message. Without it the transport loads an encoding from the
   * model id — the same guess by a slightly different route, and the only option for the
   * call sites that never count anything themselves.
   */
  countText?: (text: string) => number;
}

/**
 * Count a completion locally, for the case where the provider reported nothing.
 *
 * Encodings are cached inside `loadCounter`, so this is one dynamic import on the first
 * generation of a session and a synchronous table lookup after that.
 */
async function estimateOutputTokens(
  text: string,
  model: string,
  countText?: (t: string) => number,
) {
  if (!text) return 0;
  try {
    if (countText) return countText(text);
    const encoding: EncodingName = encodingForModel(model);
    const counter = await loadCounter(encoding);
    return counter.countText(text);
  } catch {
    // A failed estimate is not worth losing the record over — the event is still
    // evidence that a generation happened, and it is flagged as estimated regardless.
    return 0;
  }
}

/**
 * Post one generation's usage to the local server, which decides whether to log it.
 *
 * Deliberately fire-and-forget and deliberately unconditional: gating on the setting
 * here would mean threading app settings into the transport, and the request is one
 * small localhost POST per generation, not per token. Nothing it can do may disturb the
 * generation that produced it, so every failure is swallowed.
 */
async function reportUsage(
  state: StreamState,
  body: ChatCompletionBody,
  meta: UsageMeta,
  connectionId: string,
  timing: { id: string; startedAt: number; ttftMs?: number; aborted: boolean },
): Promise<void> {
  try {
    // Nothing generated and nothing reported: a request that failed before it began.
    if (!state.usage && !state.content.trim()) return;

    const model = state.model ?? (typeof body.model === 'string' ? body.model : '');
    const usage = state.usage;
    const reported = typeof usage?.completion_tokens === 'number';
    const cacheRead = usage?.cached_tokens ?? 0;

    const report: UsageReport = {
      id: timing.id,
      ts: new Date().toISOString(),
      feature: meta.feature,
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta.character ? { character: meta.character } : {}),
      connectionId,
      model,
      // OpenAI counts cached tokens inside prompt_tokens. Subtracting here keeps input
      // and cache additive for anyone summing the columns.
      inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cacheRead),
      outputTokens: reported
        ? (usage?.completion_tokens ?? 0)
        : await estimateOutputTokens(state.content, model, meta.countText),
      reasoningTokens: usage?.reasoning_tokens ?? 0,
      cacheReadTokens: cacheRead,
      durationMs: Date.now() - timing.startedAt,
      ...(timing.ttftMs !== undefined ? { ttftMs: timing.ttftMs } : {}),
      estimated: !reported,
      aborted: timing.aborted,
      outcome: timing.aborted ? 'cancelled' : state.error ? 'failed' : 'completed',
    };

    await fetch('/api/usage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      // Survives the tab closing mid-report; the server has nothing to say back.
      keepalive: true,
    });
  } catch {
    /* usage accounting must never break a generation */
  }
}

export interface StreamHandlers {
  /** Called with the FULL accumulated state — never a delta. Assign, do not append. */
  onTick: (state: StreamState) => void;
  /** Called when the first user-visible content or reasoning arrives. */
  onFirstToken?: () => void;
}

/**
 * POST a request and consume the response, streamed or not.
 *
 * This deliberately sits beside `request<T>` rather than inside it: `request` always
 * parses JSON, which a stream cannot survive. It uses fetch + a reader rather than
 * EventSource, which can neither POST nor set headers.
 *
 * @param seed Existing text to build on, for `continue`.
 */
async function streamGenerate(
  body: ChatCompletionBody,
  signal: AbortSignal,
  handlers: StreamHandlers,
  seed: string,
  connectionId: string,
  meta?: UsageMeta,
): Promise<StreamState> {
  // One id for this generation, settled before the request. Deliberately not the
  // provider's response id even when there is one: that arrives too late for a call site
  // that has to record the id on a reply the user stopped, and having two possible
  // answers to "which generation was this" is how the double-count gets back in.
  const generationId = meta?.generationId ?? crypto.randomUUID();
  const startedAt = Date.now();
  let ttftMs: number | undefined;

  const identify = (state: StreamState): StreamState => ({ ...state, generationId });
  const report = (state: StreamState, aborted: boolean) => {
    if (!meta) return;
    void reportUsage(identify(state), body, meta, connectionId, {
      id: generationId,
      startedAt,
      ttftMs,
      aborted,
    });
  };

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body,
      connectionId,
      ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const failure = (await response.json()) as { error?: string };
      if (failure?.error) message = failure.error;
    } catch {
      /* keep the status line */
    }
    throw new Error(message);
  }

  // The server mirrors the upstream content-type, so this is how we learn which we got.
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const state = identify(parseCompletion(await response.json(), seed));
    // A provider can report a failure inside an otherwise-200 body, same as a stream.
    if (state.error) throw new Error(state.error);
    ttftMs = Date.now() - startedAt;
    handlers.onFirstToken?.();
    handlers.onTick(state);
    report(state, false);
    return state;
  }

  const parser = createSseParser();
  const accumulator = createStreamAccumulator(seed);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sawToken = false;

  const publish = (state: StreamState | null) => {
    if (!state) return;
    // Thinking models commonly emit reasoning for a long time before ordinary content.
    // That is visible stream output too: leaving the chat in "connecting" hides the
    // StreamingText leaf, even though its store is receiving every reasoning delta.
    if (!sawToken && (state.content !== seed || state.reasoning)) {
      sawToken = true;
      ttftMs = Date.now() - startedAt;
      handlers.onFirstToken?.();
    }
    handlers.onTick(state);
  };

  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
  const aborted = new Promise<never>((_, reject) => {
    const fire = () => reject(abortError());
    if (signal.aborted) {
      fire();
      return;
    }
    signal.addEventListener('abort', fire, { once: true });
  });
  aborted.catch(() => {});

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;

      // stream: true keeps multi-byte characters split across chunks intact.
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        publish(accumulator.push(frame));
      }
    }

    for (const frame of parser.flush()) {
      publish(accumulator.push(frame));
    }
  } catch (error) {
    // A stopped generation was still generated, and still billed. The caller keeps the
    // partial text for that reason; the usage log keeps the partial count for the same one.
    report(accumulator.snapshot(), true);
    throw error;
  } finally {
    reader.cancel().catch(() => {});
  }

  const final = identify(accumulator.snapshot());
  report(final, false);
  // A provider can report a failure inside an otherwise-successful stream.
  if (final.error) throw new Error(final.error);
  return final;
}

export interface RunGeneration extends StreamHandlers {
  /** What to run on: a resolved slot, a session's own pick, an Arena contender. */
  model: ResolvedModel;
  /**
   * The request, built by the caller (`buildRequestBody`) — features shape their prompts
   * and budgets too differently to share a builder. Its `model` is overwritten with
   * `model.model`, so a body built against one model can never run on another.
   */
  body: ChatCompletionBody;
  signal: AbortSignal;
  /** Existing text to build on, for `continue`. */
  seed?: string;
  /** Omit only for a request that is not a generation anyone would want accounted. */
  usage?: UsageMeta;
}

/**
 * Run one generation and resolve with its final state. Rejects with an `AbortError` when
 * `signal` fires (`isAbortError`), and with the provider's message when it fails — callers
 * keep whatever `onTick` delivered either way.
 */
export function runGeneration({
  model,
  body,
  signal,
  seed = '',
  usage,
  onTick,
  onFirstToken,
}: RunGeneration): Promise<StreamState> {
  return streamGenerate(
    { ...body, model: model.model },
    signal,
    { onTick, ...(onFirstToken ? { onFirstToken } : {}) },
    seed,
    model.id,
    usage,
  );
}

/** Whether a generation ended because someone stopped it, rather than because it failed. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: unknown } | null)?.name === 'AbortError';
}
