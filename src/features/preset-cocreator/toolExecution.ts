import type { ProviderToolCall } from '@shared/providers/types.ts';
import type { PresetCocreatorMessage } from '@shared/types/preset-cocreator.ts';
import { executePresetToolCall, type PresetToolDeps, toolFailureResult } from './assistant.ts';
import { validPresetToolCallIds } from './toolHistory.ts';

function skippedTool() {
  return {
    ok: false,
    interrupted: true,
    error: 'The tool was not executed because the turn was stopped.',
  };
}

/**
 * Stop prevents the next tool, including one waiting for the pre-edit save. A mutation
 * already dispatched must settle and retain its receipt; cancellation cannot undo a commit.
 * Every call gets a result, including those skipped, so a later request can safely resume.
 */
export async function executePresetToolBatch(options: {
  calls: readonly ProviderToolCall[];
  turnId: string;
  signal: AbortSignal;
  deps: PresetToolDeps;
  onResult(message: PresetCocreatorMessage): void;
}): Promise<void> {
  const { calls, turnId, signal, deps, onResult } = options;
  if (!validPresetToolCallIds(calls)) {
    throw new Error('The model must return a unique, non-empty id for every tool call.');
  }
  for (const call of calls) {
    let result: unknown;
    if (signal.aborted) {
      result = skippedTool();
    } else {
      try {
        result = await executePresetToolCall(call, turnId, deps, signal);
      } catch (failure) {
        result =
          signal.aborted && (failure as Error).name === 'AbortError'
            ? skippedTool()
            : toolFailureResult(failure);
      }
    }
    onResult({
      id: crypto.randomUUID(),
      role: 'tool',
      content: JSON.stringify(result),
      created: Date.now(),
      toolCallId: call.id,
      toolName: call.function.name,
    });
  }
}
