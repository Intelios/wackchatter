/**
 * The design assistant's prompt.
 *
 * Deliberately NOT `assemblePrompt`. That engine walks a SillyTavern preset's prompt order
 * and needs a `CardDataV2` to feed its markers and macros; running it here would inject the
 * user's main prompt, jailbreak, world info and author's note into a conversation that has
 * nothing to do with any of them. So this is not a fourth `assemblePrompt` caller, and the
 * rule that every caller must pass the same regex script list is untouched.
 *
 * The preset still supplies samplers — `buildRequestBody` reads temperature, penalties,
 * max_tokens and friends and never looks at `prompts` or `prompt_order`, so "samplers but no
 * prompts" is what the request layer already does by construction, not something filtered
 * here.
 *
 * One invariant runs through the whole file: **everything the model sees is in the transcript
 * the user can read.** The stash is not a parameter. Neither is the examples analysis. Both
 * reach the model, when they reach it at all, as visible turns.
 */

import type { MessageState } from '@shared/chat/message.ts';
import { currentText } from '@shared/chat/message.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ApiMessage } from '@shared/types/chat.ts';
import { DEFAULT_COCREATOR_ANALYSIS_PROMPT } from '@shared/types/settings.ts';

export interface DesignPromptInput {
  systemPrompt: string;
  /** The rendered example block, or empty when nothing is attached. */
  exampleBlock: string;
  /** The transcript, including the blank placeholder being generated into. */
  messages: readonly MessageState[];
  countTokens: TokenCounter;
  /** `openai_max_context - max_tokens`. */
  maxPromptTokens: number;
}

export interface DesignPrompt {
  messages: ApiMessage[];
  tokenCounts: { system: number; examples: number; transcript: number };
  totalTokens: number;
  /** Oldest turns that did not fit. Shown in the desk when non-zero. */
  droppedMessages: number;
  /** The pinned content alone does not fit — the user must detach examples. */
  fixedOverflow: boolean;
}

/**
 * The request the "Analyse examples" button sends.
 *
 * A constant rather than a hidden prompt path: it is appended as an ordinary visible user
 * turn and answered by an ordinary generation. That is what makes "the user can verify the
 * model saw every example" true rather than merely claimed — the answer sits in the
 * transcript, is swipeable, and stays in context for later turns.
 */
/** Legacy export retained for stored-session recognition and existing callers. */
export const ANALYSE_EXAMPLES_REQUEST = DEFAULT_COCREATOR_ANALYSIS_PROMPT;

export function isAnalyseRequest(text: string): boolean {
  return text.trim() === ANALYSE_EXAMPLES_REQUEST;
}

export function buildDesignPrompt(input: DesignPromptInput): DesignPrompt {
  const { systemPrompt, exampleBlock, messages, countTokens, maxPromptTokens } = input;

  // No macro substitution. There is no character, no persona and no chat variable scope, so
  // the only things the macro engine could do here are expand a stray {{char}} to an empty
  // string and let a {{setvar}} in the user's own system prompt write global state from a
  // screen that has no story.
  const fixed: ApiMessage[] = [];
  if (systemPrompt.trim()) fixed.push({ role: 'system', content: systemPrompt });
  // One message rather than one per card, so the model reads them as a single exhibit and
  // the panel has one number to show.
  if (exampleBlock.trim()) fixed.push({ role: 'system', content: exampleBlock });

  // gpt-tokenizer includes completion priming in every whole-chat count, so subtract it when
  // costing an individual message and charge it once against the assembled payload. Same
  // accounting as shared/prompt/assemble.ts:483.
  const replyPriming = countTokens.countChat([]);
  const messageCost = (message: ApiMessage) => countTokens.countChat([message]) - replyPriming;

  const fixedTokens = countTokens.countChat(fixed);
  const systemTokens = fixed[0] ? messageCost(fixed[0]) : 0;
  const examplesTokens = fixed[1] ? messageCost(fixed[1]) : 0;

  // A blank message is the placeholder being generated into. Skipping it is what excludes a
  // reply from its own prompt — no splicing, no special case, the same trick `assemble` uses.
  const visible = messages.filter((message) => currentText(message).trim());

  const packed: ApiMessage[] = [];
  let transcriptTokens = 0;
  let droppedMessages = 0;

  const fixedOverflow = fixedTokens > maxPromptTokens;
  if (fixedOverflow) {
    // Nothing will fit alongside it. Report the whole transcript as dropped rather than
    // pretending a partial pack succeeded.
    droppedMessages = visible.length;
  } else {
    // Newest-first, hard stop at the first turn that does not fit — the same policy as chat
    // history packing. A design conversation grows without bound, so this is what stops a
    // long session turning into an opaque provider error.
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const message = visible[i]!;
      const entry: ApiMessage = {
        role: message.is_user ? 'user' : 'assistant',
        // No `name`: names_behavior is a roleplay concern and there are only two speakers.
        content: currentText(message),
      };
      const cost = messageCost(entry);
      if (fixedTokens + transcriptTokens + cost > maxPromptTokens) {
        droppedMessages = i + 1;
        break;
      }
      transcriptTokens += cost;
      packed.unshift(entry);
    }
  }

  const assembled = [...fixed, ...packed];
  return {
    messages: assembled,
    tokenCounts: { system: systemTokens, examples: examplesTokens, transcript: transcriptTokens },
    totalTokens: countTokens.countChat(assembled),
    droppedMessages,
    fixedOverflow,
  };
}

/**
 * Render the stash as the body of a visible user turn.
 *
 * The stash is never appended to the prompt automatically: it is the user's editorial
 * decision rather than conversational context, re-sending it doubles the cost of text the
 * model just wrote, and a model shown its own filed output tends to restate it. When the
 * user does want the model to see where things stand, this becomes a turn they can read.
 */
export function renderStashRequest(slots: readonly { label: string; text: string }[]): string {
  if (slots.length === 0) return 'Nothing is filed into the card yet.';
  const body = slots.map((slot) => `${slot.label}:\n${slot.text}`).join('\n\n');
  return `Here is what I have filed into the card so far. Use it as the current state — do not restate it back to me unless I ask.\n\n${body}`;
}
