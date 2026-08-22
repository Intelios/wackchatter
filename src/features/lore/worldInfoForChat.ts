/**
 * The bridge between the loaded lorebooks and the activation engine.
 *
 * Called from exactly two places — `useChat.generate` and `usePromptPreview` — so the
 * preview and the send cannot disagree about what fires. `memoryRecallForChat` lives here
 * rather than beside the memory code for the same reason: it shares `seedFor`, so the two
 * passes roll their probabilities identically, and anyone adding a third call site has
 * both functions in front of them.
 */

import type { MemoryRecall } from '@shared/memory/source.ts';
import { recallMemories } from '@shared/memory/source.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ChatMessage, Memory } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import { CHARACTER_NAMES_BEHAVIOR } from '@shared/types/preset.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { ActivationResult, WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { activateWorldInfo, worldInfoBudget } from '@shared/worldinfo/activate.ts';

export interface WorldInfoForChatOptions {
  sources: WorldInfoSource[];
  messages: ChatMessage[];
  settings: WorldInfoSettings;
  preset: Preset;
  chatId: string | null;
  /** The SAME memoised counter assembly uses, or every entry is tokenised twice. */
  countTokens: TokenCounter;
}

/**
 * Seed the engine's randomness on the last USER message, not the last message.
 *
 * `generate` appends the assistant placeholder before assembling, so the last message id
 * is a fresh uuid on every attempt — seeding on it would re-roll every probability and
 * group draw on each regenerate, and the lore would change underneath a comparison that
 * was supposed to be about the model. Keyed this way, regenerate, swipe and continue all
 * see identical lore, a new turn rolls fresh, and the preview matches the send.
 */
function seedFor(chatId: string | null, messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.is_user) return `${chatId ?? 'chat'}:${message.id}`;
  }
  return `${chatId ?? 'chat'}:start`;
}

export function worldInfoForChat(options: WorldInfoForChatOptions): ActivationResult | null {
  const { sources, messages, settings, preset, chatId, countTokens } = options;
  if (sources.length === 0) return null;

  const maxContext = preset.openai_max_context ?? 4095;

  return activateWorldInfo({
    sources,
    messages,
    settings,
    budget: worldInfoBudget(settings, maxContext),
    countTokens: countTokens.countText,
    // Match how the transcript will be rendered into the prompt, so a key that only
    // appears in a name prefix behaves consistently between the scan and the send.
    includeNames: preset.names_behavior === CHARACTER_NAMES_BEHAVIOR.CONTENT,
    seed: seedFor(chatId, messages),
  });
}

export interface MemoryRecallForChatOptions {
  /** This chat's memories, oldest first. */
  memories: Memory[] | undefined;
  messages: ChatMessage[];
  /** Global scan settings, shared with lore: scan depth, case, whole words. */
  settings: WorldInfoSettings;
  /** `MemorySettings.budgetTokens` — the memory allowance, not the World Info one. */
  budget: number;
  preset: Preset;
  chatId: string | null;
  /** The SAME memoised counter assembly uses, or every memory is tokenised twice. */
  countTokens: TokenCounter;
}

/**
 * Which memories this turn recalls: the pinned ones, plus whatever the keywords woke.
 *
 * A pass of its own, over the memory source alone — see `shared/memory/source.ts` for why
 * it does not simply join the lorebook sources. Returns null when the chat has no memories,
 * which is also what `memoryMode: 'classic'` and `'off'` look like from here: the caller
 * does not run it, and the story-memory slot stays empty or holds the summary instead.
 */
export function memoryRecallForChat(options: MemoryRecallForChatOptions): MemoryRecall | null {
  const { memories, messages, settings, budget, preset, chatId, countTokens } = options;
  if (!memories?.length) return null;

  return recallMemories({
    memories,
    messages,
    settings,
    budget,
    countTokens: countTokens.countText,
    includeNames: preset.names_behavior === CHARACTER_NAMES_BEHAVIOR.CONTENT,
    seed: seedFor(chatId, messages),
  });
}
