/**
 * The upstream call.
 *
 * This is the only part of the server that talks to a provider, and it has no opinion
 * about the body it forwards — the browser built that with shared/providers/request.ts.
 * All this adds is the base URL and the API key, which is exactly the reason the key
 * never has to leave the machine.
 */

import {
  buildHeaders,
  completionsUrl,
  modelsUrl,
  parseModelList,
} from '../../shared/providers/request.ts';
import { extractError } from '../../shared/providers/sse.ts';
import type {
  ChatCompletionBody,
  ConnectionSettings,
  ProviderModel,
} from '../../shared/providers/types.ts';
import { getApiKey } from './secrets.ts';
import { getSettings } from './settings.ts';

/**
 * Replies believed to be streaming right now, by start time.
 *
 * The data folder must not move mid-generation: the stream itself holds no files and would
 * survive, but the request that saves the finished reply would land on a gated server and
 * the reply would be lost. Entries older than the cap are ignored rather than trusted — a
 * client that hangs up without draining the stream may never run the transform's flush, and
 * one leaked entry would otherwise block the folder from ever moving again. Ten minutes is
 * far longer than any real reply takes.
 */
const inFlight = new Set<{ started: number }>();
const STALE_AFTER_MS = 10 * 60 * 1000;

export function activeGenerations(): number {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const entry of inFlight) {
    if (entry.started < cutoff) inFlight.delete(entry);
  }
  return inFlight.size;
}

/** Mark a generation as started. The returned function is safe to call more than once. */
export function trackGeneration(): () => void {
  const entry = { started: Date.now() };
  inFlight.add(entry);
  return () => {
    inFlight.delete(entry);
  };
}

/** Sent to OpenRouter as HTTP-Referer. Dev and prod differ; either is a valid origin. */
function appUrl(): string {
  const port = process.env.WC_PORT ?? '8787';
  return process.env.NODE_ENV === 'production'
    ? `http://localhost:${port}`
    : 'http://localhost:5173';
}

/**
 * Forward a chat-completion request.
 *
 * The caller's AbortSignal is passed through to the upstream fetch. Without that, hitting
 * Stop would only close the browser's socket while the provider kept generating — and
 * kept billing.
 */
export async function callUpstream(
  body: ChatCompletionBody,
  signal: AbortSignal,
): Promise<Response> {
  const connection = getSettings().connection;

  if (!connection.baseUrl) throw new Error('No endpoint configured. Set one in Connection.');
  if (!connection.model) throw new Error('No model selected. Choose one in Connection.');

  return fetch(completionsUrl(connection), {
    method: 'POST',
    headers: buildHeaders(connection, getApiKey(connection.provider), appUrl()),
    body: JSON.stringify(body),
    signal,
  });
}

/** Fetch the model catalogue for a connection, defaulting to the configured one. */
export async function listModels(connection?: ConnectionSettings): Promise<ProviderModel[]> {
  const target = connection ?? getSettings().connection;
  if (!target.baseUrl) throw new Error('No endpoint configured.');

  const response = await fetch(modelsUrl(target), {
    headers: buildHeaders(target, getApiKey(target.provider), appUrl()),
    // A model list that hangs should not hold a request open indefinitely.
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(describeFailure(response.status, text));
  }

  try {
    return parseModelList(JSON.parse(text));
  } catch {
    throw new Error('The endpoint returned a model list that is not valid JSON.');
  }
}

export type TestResult = { ok: true; models: number } | { ok: false; error: string };

/** Probe a connection without committing to it, for the "Test" button. */
export async function testConnection(connection: ConnectionSettings): Promise<TestResult> {
  try {
    const models = await listModels(connection);
    return { ok: true, models: models.length };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Turn an upstream failure into something worth showing a user.
 *
 * Providers put the useful text in the body, not the status line, so the body is read
 * first and the status is only a fallback.
 */
export function describeFailure(status: number, rawBody: string): string {
  let message: string | null = null;
  try {
    message = extractError(JSON.parse(rawBody));
  } catch {
    // Not JSON — a proxy error page or a plain-text message.
    message = rawBody.trim() ? rawBody.trim().slice(0, 500) : null;
  }

  if (status === 401 || status === 403) {
    return message ?? 'The provider rejected the API key.';
  }
  if (status === 429) {
    return message ?? 'Rate limited by the provider.';
  }

  return message ?? `Provider returned ${status}.`;
}
