import {
  type CompactionPlan,
  type CompactionRecord,
  recordCompaction,
} from '@shared/cocreator/compaction.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import { isLengthCutoff, type StreamState } from '@shared/providers/sse.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { UsageFeature } from '@shared/types/usage.ts';
import { runGeneration } from '../../lib/generation.ts';

/** Uses the caller's model and generation gate. Failed/stopped requests keep usage, never coverage. */
export async function runCompaction(options: {
  plan: CompactionPlan;
  model: ResolvedModel;
  preset: Preset;
  signal: AbortSignal;
  sessionId: string;
  feature: UsageFeature;
  countText(text: string): number;
  streaming?: boolean;
}): Promise<CompactionRecord> {
  const id = crypto.randomUUID();
  const created = Date.now();
  let state: StreamState | null = null;
  let error: string | undefined;
  try {
    options.signal.throwIfAborted();
    state = await runGeneration({
      model: options.model,
      body: buildRequestBody({
        messages: options.plan.request,
        preset: options.preset,
        connection: options.model,
        stream: options.streaming ?? true,
        maxTokens: null,
      }),
      signal: options.signal,
      usage: {
        feature: options.feature,
        generationId: id,
        sessionId: options.sessionId,
        countText: options.countText,
      },
      onTick: (value) => {
        state = value;
      },
    });
    options.signal.throwIfAborted();
    if (isLengthCutoff(state.finishReason))
      throw new Error('The compaction reply was cut off. The previous context is still in use.');
    if (!state.content.trim())
      throw new Error('The compaction returned no summary. The previous context is still in use.');
    if (state.toolCalls?.length || state.finishReason === 'content_filter')
      throw new Error(
        'The compaction did not return a complete summary. The previous context is still in use.',
      );
  } catch (failure) {
    error = options.signal.aborted ? 'Compaction stopped.' : (failure as Error).message;
  }
  return recordCompaction(options.plan, {
    id,
    created,
    model: { connectionId: options.model.id, modelId: options.model.model },
    status: options.signal.aborted ? 'aborted' : error ? 'failed' : 'complete',
    summary: error ? undefined : state?.content,
    ...(state?.usage?.prompt_tokens !== undefined
      ? { inputTokens: state.usage.prompt_tokens }
      : {}),
    ...(state?.usage?.completion_tokens !== undefined
      ? { outputTokens: state.usage.completion_tokens }
      : {}),
    ...(error ? { error } : {}),
  });
}
