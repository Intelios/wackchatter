/**
 * The bridge between the loaded lorebooks and the activation engine.
 *
 * One function, called from exactly two places — `useChat.generate` and
 * `usePromptPreview` — so the preview and the send cannot disagree about what lore fires.
 */

import type { ChatMessage } from '@shared/types/chat.ts';
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
  countTokens: (text: string) => number;
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
    countTokens,
    // Match how the transcript will be rendered into the prompt, so a key that only
    // appears in a name prefix behaves consistently between the scan and the send.
    includeNames: preset.names_behavior === CHARACTER_NAMES_BEHAVIOR.CONTENT,
    seed: seedFor(chatId, messages),
  });
}
