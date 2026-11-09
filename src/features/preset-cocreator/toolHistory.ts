import type { ProviderToolCall } from '@shared/providers/types.ts';
import type {
  PresetCocreatorMessage,
  PresetDraftRevision,
} from '@shared/types/preset-cocreator.ts';

export type PresetToolRevision = Pick<
  PresetDraftRevision,
  'revision' | 'source' | 'turnId' | 'operationId' | 'diff'
>;

export function presetToolOperationId(turnId: string, callId: string): string {
  return `tool:${turnId}:${callId}`;
}

/** Validate the whole batch before any tool can change the draft. */
export function validPresetToolCallIds(calls: readonly ProviderToolCall[]): boolean {
  const seen = new Set<string>();
  return calls.every((call) => {
    if (typeof call.id !== 'string' || !call.id.trim() || seen.has(call.id)) return false;
    seen.add(call.id);
    return true;
  });
}

/**
 * A disposable provider projection, never an edit of the saved conversation. Every emitted
 * call gets exactly one adjacent result. Missing results are evidence of interruption,
 * never a reason to execute a saved call again. A recorded patch operation proves what
 * committed even if the application stopped before saving its tool result.
 */
export function presetToolHistory(
  messages: readonly PresetCocreatorMessage[],
  history: readonly PresetToolRevision[] = [],
): PresetCocreatorMessage[] {
  const callCounts = new Map<string, number>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
    }
  }
  const operations = new Map(history.map((revision) => [revision.operationId, revision]));

  function committedPatch(message: PresetCocreatorMessage, call: ProviderToolCall) {
    if (call.function.name !== 'patch_preset') return undefined;
    if (message.turnId) {
      const revision = operations.get(presetToolOperationId(message.turnId, call.id));
      return revision?.source === 'assistant' && revision.turnId === message.turnId
        ? revision
        : undefined;
    }
    // Older messages did not save their turn id. Only a unique call and a unique exact
    // operation identity may establish the link; repeated provider ids remain unknown.
    if (callCounts.get(call.id) !== 1) return undefined;
    const matches = history.filter(
      (revision) =>
        revision.source === 'assistant' &&
        revision.turnId &&
        revision.operationId === presetToolOperationId(revision.turnId, call.id),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  const projected: PresetCocreatorMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    // Orphaned results stay inspectable on disk, but are invalid provider input.
    if (message.role === 'tool') continue;
    if (message.role !== 'assistant') {
      projected.push(message);
      continue;
    }

    const originalCalls = message.toolCalls ?? [];
    const invalid = !validPresetToolCallIds(originalCalls);
    const incompleteCalls =
      invalid ||
      !!message.incompleteToolCalls?.length ||
      (!!message.incomplete && !!originalCalls.length);
    const calls = incompleteCalls ? [] : originalCalls;
    // Opaque signatures belong to the original tool exchange. Do not replay them when
    // that malformed/incomplete exchange itself cannot be sent. Valid exchanges keep all
    // metadata unchanged, including signatures on individual parallel calls.
    const assistant = incompleteCalls
      ? {
          ...message,
          incomplete: message.incomplete ?? ('error' as const),
          toolCalls: undefined,
          reasoningFields: undefined,
          reasoningDetails: undefined,
          extraContent: undefined,
        }
      : message;
    if (assistant.content || calls.length) projected.push(assistant);

    const results = new Map<string, PresetCocreatorMessage>();
    while (messages[index + 1]?.role === 'tool') {
      const result = messages[++index]!;
      if (result.toolCallId && !results.has(result.toolCallId)) {
        results.set(result.toolCallId, result);
      }
    }
    for (const [callIndex, call] of calls.entries()) {
      const existing = results.get(call.id);
      const committed = committedPatch(message, call);
      // A known commit outranks a missing/failed acknowledgement, but ordinary saved
      // results retain their exact bytes. In particular, never turn an uncertain edit into
      // a claim that nothing changed merely because the transport failed.
      let succeeded = false;
      try {
        succeeded = JSON.parse(existing?.content ?? 'null')?.ok === true;
      } catch {
        // Displayable non-JSON results need no special treatment.
      }
      if (existing && (!committed || succeeded)) {
        projected.push(existing);
        continue;
      }
      const result = committed
        ? { ok: true, revision: committed.revision, diff: committed.diff, recovered: true }
        : {
            ok: false,
            interrupted: true,
            ...(call.function.name === 'patch_preset' ? { outcomeUnknown: true } : {}),
            error:
              'No result was recorded for this interrupted tool call. Do not assume it ran or ' +
              'repeat an edit blindly; inspect the current draft before deciding what is still needed.',
          };
      projected.push({
        id: `${message.id}:recovered:${callIndex}`,
        role: 'tool',
        content: JSON.stringify(result),
        created: message.created,
        toolCallId: call.id,
        toolName: call.function.name,
      });
    }
  }
  return projected;
}
