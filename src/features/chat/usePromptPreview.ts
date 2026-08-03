import { type AssembleResult, assemblePrompt } from '@shared/prompt/assemble.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ChatMessage, ChatMetadata, MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { GuidanceSettings, SummarySettings } from '@shared/types/settings.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { ActivationResult, WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { useEffect, useState } from 'react';
import { worldInfoForChat } from '../lore/worldInfoForChat.ts';

const DEBOUNCE_MS = 200;

export interface PromptPreviewInput {
  preset: Preset;
  character: CardDataV2;
  persona: Persona | null;
  messages: ChatMessage[];
  countTokens: TokenCounter;
  worldInfoSources?: WorldInfoSource[];
  worldInfoSettings?: WorldInfoSettings;
  chatId?: string | null;
  chatMetadata?: ChatMetadata;
  /**
   * Guidance config only. One-shot guidance is deliberately absent for the same reason
   * the composer's text is: it is not part of what the next prompt costs until you press
   * the button, and re-assembling per keystroke would buy nothing.
   */
  guidanceSettings?: GuidanceSettings;
  summarySettings?: SummarySettings;
  globalVariables?: MacroVariableMap;
}

export type PromptPreview = AssembleResult & {
  /** What World Info would do, for the Lore tab and the inspector. */
  worldInfo: ActivationResult | null;
};

/**
 * Assemble the prompt that *would* be sent, for the Prompt Manager's live token counts.
 *
 * Takes the inputs individually rather than an options object so the dependency list is
 * complete: an object rebuilt every render would either re-run this constantly or, if
 * keyed on its fields, go stale the moment someone added one.
 *
 * Debounced, and deliberately unaware of the composer's text — retyping a message would
 * otherwise re-run assembly on every keystroke for numbers that cannot change.
 *
 * World Info runs through the same `worldInfoForChat` the send uses, seeded the same way,
 * so the preview and the send agree about which entries fire.
 */
export function usePromptPreview(input: PromptPreviewInput | null): PromptPreview | null {
  const [result, setResult] = useState<PromptPreview | null>(null);

  const preset = input?.preset;
  const character = input?.character;
  const persona = input?.persona;
  const messages = input?.messages;
  const countTokens = input?.countTokens;
  const worldInfoSources = input?.worldInfoSources;
  const worldInfoSettings = input?.worldInfoSettings;
  const chatId = input?.chatId ?? null;
  const chatMetadata = input?.chatMetadata;
  const guidanceSettings = input?.guidanceSettings;
  const summarySettings = input?.summarySettings;
  const globalVariables = input?.globalVariables;

  useEffect(() => {
    if (!preset || !character || !messages || !countTokens) {
      setResult(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        const lore =
          worldInfoSources && worldInfoSettings
            ? worldInfoForChat({
                sources: worldInfoSources,
                messages,
                settings: worldInfoSettings,
                preset,
                chatId,
                countTokens,
              })
            : null;

        const assembled = assemblePrompt({
          preset,
          character,
          persona,
          messages,
          worldInfoBefore: lore?.before,
          worldInfoAfter: lore?.after,
          worldInfoDepth: lore?.depth,
          scenarioOverride:
            typeof chatMetadata?.scenario === 'string' ? chatMetadata.scenario : undefined,
          authorNote: chatMetadata?.authorNote,
          summary: chatMetadata?.summary,
          summarySettings,
          guides: chatMetadata?.guides,
          guidanceSettings,
          localVariables: chatMetadata?.variables ?? {},
          globalVariables: globalVariables ?? {},
          countTokens,
        });

        setResult({ ...assembled, worldInfo: lore });
      } catch {
        // A preset mid-edit can be momentarily invalid; the counts simply stall.
        setResult(null);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    preset,
    character,
    persona,
    messages,
    countTokens,
    worldInfoSources,
    worldInfoSettings,
    chatId,
    chatMetadata,
    guidanceSettings,
    summarySettings,
    globalVariables,
  ]);

  return result;
}
