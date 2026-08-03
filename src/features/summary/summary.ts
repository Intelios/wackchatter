import type { AssembleResult } from '@shared/prompt/assemble.ts';
import type { ChatMessage, StorySummary } from '@shared/types/chat.ts';

export interface PackedClassicSummaryChunk {
  messages: ChatMessage[];
  assembled: Extract<AssembleResult, { ok: true }>;
}

/** Transcript turns eligible for summary generation, still carrying their native roles. */
export function summaryMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.is_system || !message.mes.trim()) return [];
    return [{ ...message, mes: message.mes.trim() }];
  });
}

/** Messages not yet covered by the checkpoint. A missing checkpoint restarts at the top. */
export function summaryBacklog(messages: ChatMessage[], summary?: StorySummary): ChatMessage[] {
  if (!summary?.checkpointMessageId) return messages;
  const checkpoint = messages.findIndex((message) => message.id === summary.checkpointMessageId);
  return checkpoint === -1 ? messages : messages.slice(checkpoint + 1);
}

export function resolveSummaryPrompt(prompt: string, targetWords: number): string {
  return prompt.replaceAll('{{words}}', String(targetWords));
}

/** A private control for the summarizer, independent of ordinary summary injection. */
export function summaryBaseControl(text: string): string {
  return text.trim() ? `Existing rolling summary:\n${text.trim()}` : '';
}

/**
 * Pack the oldest contiguous prefix whose complete Classic assembly retains every turn.
 * The accepted assembly is returned verbatim so dynamic lore and macros are not rerun.
 */
export function packClassicSummaryChunk(
  messages: ChatMessage[],
  assemble: (candidate: ChatMessage[]) => AssembleResult,
): PackedClassicSummaryChunk | null {
  let accepted: ChatMessage[] = [];
  let acceptedAssembly: Extract<AssembleResult, { ok: true }> | null = null;

  for (const message of messages) {
    const candidate = [...accepted, message];
    const assembled = assemble(candidate);
    if (!assembled.ok || assembled.droppedMessages > 0) break;
    accepted = candidate;
    acceptedAssembly = assembled;
  }

  return acceptedAssembly ? { messages: accepted, assembled: acceptedAssembly } : null;
}
