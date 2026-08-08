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

/** Yield to the browser's event loop so the progress UI can paint mid-run. */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** How often the estimate walk hands control back to the event loop. */
const ESTIMATE_YIELD_INTERVAL = 100;

/** How many verify/shrink rounds a chunk may need before giving up. */
const MAX_VERIFY_ATTEMPTS = 16;

export interface PackClassicSummaryChunkOptions {
  /** Oldest-first transcript turns, already trimmed and filtered by `summaryMessages`. */
  messages: ChatMessage[];
  /** Context budget for the whole assembled prompt: `openai_max_context - maxTokens`. */
  maxPromptTokens: number;
  /** Tokens of the empty-history assembly (fixed prompts, controls, rolling base). */
  fixedTokens: number;
  /** Marginal token cost of one message, mirroring assembly's per-message pricing. */
  messageCost: (message: ChatMessage) => number;
  /** Full Classic assembly for a candidate prefix; lore is computed from the candidate. */
  assemble: (candidate: ChatMessage[]) => AssembleResult;
}

/**
 * Pack the oldest contiguous prefix whose complete Classic assembly retains every turn.
 * The accepted assembly is returned verbatim so dynamic lore and macros are not rerun.
 *
 * The old implementation re-ran the full assembly for every growing prefix, which is
 * O(K³) on a single-chunk backlog (each assembly is itself O(K²) in per-message budget
 * checks) — a 500-message chat at a large context froze the tab. Instead we walk the
 * backlog once with the cheap per-message token estimate, then verify the chosen prefix
 * with a handful of full assemblies, shrinking by the reported `droppedMessages` when
 * macros, regex or lore make the estimate optimistic.
 */
export async function packClassicSummaryChunk(
  options: PackClassicSummaryChunkOptions,
): Promise<PackedClassicSummaryChunk | null> {
  const { messages, maxPromptTokens, fixedTokens, messageCost, assemble } = options;

  // --- Estimate: one cheap per-message cost, no assembly -----------------
  let budget = maxPromptTokens - fixedTokens;
  let estimated = 0;
  for (const message of messages) {
    const cost = messageCost(message);
    if (budget - cost < 0) break;
    budget -= cost;
    estimated++;
    if (estimated % ESTIMATE_YIELD_INTERVAL === 0) await yieldToMain();
  }
  if (estimated === 0) return null;

  // --- Verify: at most a few full assemblies, shrinking on drops ----------
  let size = estimated;
  for (let attempt = 0; attempt < MAX_VERIFY_ATTEMPTS; attempt++) {
    const candidate = messages.slice(0, size);
    const assembled = assemble(candidate);
    if (!assembled.ok) return null;
    if (assembled.droppedMessages === 0) return { messages: candidate, assembled };
    size -= assembled.droppedMessages;
    if (size <= 0) return null;
  }
  return null;
}
