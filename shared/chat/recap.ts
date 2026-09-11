/**
 * The "Previously on…" recap request.
 *
 * A recap is not a chat turn. Going through `assemblePrompt` would carry the preset's main
 * prompt, the character sheet, the persona, the lorebook and every stored macro into the
 * request — and the whole point of the feature is that the user asked for the transcript
 * and nothing else. So the request is built here by hand, the same way memory extraction
 * (`shared/memory/extract.ts`) and persona derivation (`shared/persona/derive.ts`) bypass
 * assembly, and for the same reason: what a preset says must not weigh in.
 *
 * Pure, and tested without a DOM. The prompt is two messages; the only interesting decision
 * is what to drop when a long chat does not fit the context the user declared.
 */

import type { TokenCounter } from '../prompt/token-cache.ts';
import type { ApiMessage, ChatMessage } from '../types/chat.ts';

/**
 * Fixed, and deliberately not a preset field.
 *
 * A recap is a reading of the transcript, not a continuation of it: the instruction has to
 * survive a preset swap untouched, and the feature exists because the user wanted the raw
 * story rather than a configurable summariser. The shape is television, not documentation —
 * a spoken "previously on" over the title card.
 */
export const RECAP_PROMPT = [
  'You are writing a "Previously on…" recap of a chat between a user and a character, in',
  'the tone of a television recap that opens the next episode.',
  'Read the transcript below and retell only what happened in it. Cover the through-line',
  'and where the story now stands — the situation, the relationships, the open questions —',
  'in a few short paragraphs.',
  'Address the user directly, in the past tense, and go straight into it: the words',
  '"Previously on" are already on screen above your reply, so do not open with them.',
  'Do not describe anyone’s character sheet, personality or appearance, do not continue the',
  'scene, and do not speak in any character’s voice. Do not invent anything the transcript',
  'does not say.',
].join(' ');

/**
 * Prepended to the transcript when the oldest turns did not fit, so the model knows it is
 * reading the tail of a longer story rather than the whole of a short one.
 */
export const RECAP_OMISSION_MARKER = '— earlier messages omitted —';

export interface RecapTurn {
  name: string;
  text: string;
}

/**
 * The visible turns, in transcript order.
 *
 * The same filter the classic summariser and Nexus extraction apply: a hidden `is_system`
 * message is not story, and a blank turn is not a turn. Names are used as recorded — the
 * transcript, not the card, is the source.
 */
export function recapTurns(messages: readonly ChatMessage[]): RecapTurn[] {
  const turns: RecapTurn[] = [];
  for (const message of messages) {
    if (message.is_system) continue;
    const text = message.mes.trim();
    if (!text) continue;
    const name = message.name.trim() || (message.is_user ? 'User' : 'Assistant');
    turns.push({ name, text });
  }
  return turns;
}

/** `Name: text` lines, oldest first — the transcript exactly as the model is given it. */
export function serializeRecapTranscript(turns: readonly RecapTurn[]): string {
  return turns.map((turn) => `${turn.name}: ${turn.text}`).join('\n');
}

export interface RecapBuild {
  /**
   * The instruction, then one user turn holding the transcript. Empty when even the
   * instruction does not fit the declared context — the caller turns that into a visible
   * failure rather than sending a request the provider would reject.
   */
  messages: ApiMessage[];
  /** Visible turns in the chat, before any truncation. */
  total: number;
  /** Turns dropped from the front to fit. */
  dropped: number;
  /** The whole prompt as counted, instruction included. */
  promptTokens: number;
  /** False when nothing can be sent inside the declared context. */
  fits: boolean;
}

/**
 * Assemble the recap request against the connection's declared context.
 *
 * The budget is `maxContext - maxTokens`, the same arithmetic assembly and the classic
 * summariser use, so the recap asks for no more room than a reply would. The transcript is
 * one user turn; when it overflows, the **oldest** turns go first. A recap that lost its
 * ending has nothing to recap, while one that lost its opening is exactly what "previously
 * on" is for — the recent episodes, not the pilot.
 */
export function buildRecapRequest(options: {
  messages: readonly ChatMessage[];
  counter: TokenCounter;
  maxContext: number;
  maxTokens: number;
}): RecapBuild {
  const { messages, counter, maxContext, maxTokens } = options;
  const turns = recapTurns(messages);
  const budget = Math.max(0, maxContext - maxTokens);
  const instruction: ApiMessage = { role: 'system', content: RECAP_PROMPT };

  // The instruction is not negotiable. If it alone overflows the declared context there is
  // no request to make, and `fits: false` is the caller's signal to say so plainly.
  const fixedTokens = counter.countChat([instruction]);
  if (fixedTokens > budget) {
    return {
      messages: [],
      total: turns.length,
      dropped: turns.length,
      promptTokens: fixedTokens,
      fits: false,
    };
  }

  const transcriptAt = (keep: number): ApiMessage[] => {
    const kept = turns.slice(turns.length - keep);
    const body = serializeRecapTranscript(kept);
    const text = keep < turns.length ? `${RECAP_OMISSION_MARKER}\n${body}` : body;
    return [instruction, { role: 'user', content: text }];
  };

  /*
   * Binary search over how many trailing turns fit. Dropping has to be a prefix, which
   * makes the prompt monotonic in `keep`; a thousand-turn chat costs ten counts instead of
   * a thousand, and each count is over a memoised body.
   */
  let low = 0;
  let high = turns.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (counter.countChat(transcriptAt(mid)) <= budget) low = mid;
    else high = mid - 1;
  }

  const built = transcriptAt(low);
  const promptTokens = counter.countChat(built);

  // `low === 0` means even a transcript reduced to its own omission marker does not fit.
  if (promptTokens > budget) {
    return {
      messages: [],
      total: turns.length,
      dropped: turns.length,
      promptTokens,
      fits: false,
    };
  }

  return {
    messages: built,
    total: turns.length,
    dropped: turns.length - low,
    promptTokens,
    fits: true,
  };
}
