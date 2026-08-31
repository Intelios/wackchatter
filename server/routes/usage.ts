/**
 * Usage reporting.
 *
 * The browser posts what it saw — model, token counts, timings — and this decides whether
 * any of it gets written. The setting is checked here rather than in the client so that
 * turning the log off is authoritative: a stale tab cannot keep writing, and the client
 * never has to hold a copy of the answer.
 *
 * `provider` is resolved here too. The client sends a connection id and nothing else about
 * the endpoint, the same rule the generation proxy follows.
 */

import { isUsageFeature, type UsageRecord, type UsageReport } from '../../shared/types/usage.ts';
import { generationConnection } from '../lib/generate.ts';
import { errorResponse, json, readJson } from '../lib/http.ts';
import { getSettings } from '../lib/settings.ts';
import { appendUsage } from '../lib/usage.ts';

/** Non-negative integer, or 0. Counts arrive from a provider and are not to be trusted. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function validate(payload: unknown): UsageReport | null {
  if (!payload || typeof payload !== 'object') return null;
  const report = payload as Partial<UsageReport>;
  if (typeof report.id !== 'string' || !report.id) return null;
  if (typeof report.ts !== 'string' || Number.isNaN(Date.parse(report.ts))) return null;
  if (!isUsageFeature(report.feature)) return null;
  if (typeof report.model !== 'string') return null;
  return report as UsageReport;
}

export async function handleUsageRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  if (segments.length !== 0 || request.method !== 'POST') return null;

  // Answered before the body is even looked at. With the log off this is the whole
  // request, and the client is free to keep posting into it.
  const settings = getSettings();
  if (!settings.usageLog) return json({ logged: false });

  const report = validate(await readJson<unknown>(request));
  if (!report) return errorResponse('Malformed usage report.');

  let provider: string | undefined;
  try {
    provider = generationConnection(settings, report.connectionId)?.provider;
  } catch {
    // A connection deleted between the generation and this report. The tokens were still
    // spent, so the record is worth keeping without the provider attribution.
    provider = undefined;
  }

  const record: UsageRecord = {
    v: 1,
    id: report.id,
    ts: report.ts,
    feature: report.feature,
    ...(report.sessionId ? { session_id: report.sessionId } : {}),
    ...(report.character ? { character: report.character } : {}),
    ...(provider ? { provider } : {}),
    ...(report.connectionId ? { connection_id: report.connectionId } : {}),
    model: report.model,
    input_tokens: count(report.inputTokens),
    output_tokens: count(report.outputTokens),
    reasoning_tokens: count(report.reasoningTokens),
    cache_read_tokens: count(report.cacheReadTokens),
    cache_write_tokens: 0,
    duration_ms: count(report.durationMs),
    ...(report.ttftMs !== undefined ? { ttft_ms: count(report.ttftMs) } : {}),
    estimated: report.estimated === true,
    aborted: report.aborted === true,
  };

  return json({ logged: appendUsage(record) });
}
