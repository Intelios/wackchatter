/**
 * The Classic summary's prompt, as pure functions: what one chunk of transcript is sent with,
 * and what each message costs to include. `useChatSummary` runs the paid loop; this decides
 * what goes in it, so the pricing can be checked against assembly without a provider.
 */

import { assemblePrompt, sanitizeName } from '@shared/prompt/assemble.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type {
  ApiMessage,
  ChatMessage,
  ChatMetadata,
  MacroVariableMap,
  Persona,
} from '@shared/types/chat.ts';
import { CHARACTER_NAMES_BEHAVIOR, type Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { GuidanceSettings } from '@shared/types/settings.ts';
import type { ActivationResult } from '@shared/worldinfo/activate.ts';
import { summaryBaseControl } from './summary.ts';

/**
 * One message's marginal cost in the summary prompt, mirroring assembly's pricing exactly:
 * role from `is_user`, the names_behavior content prefix or sanitized name, and the chat cost
 * minus the reply priming. Raw trimmed text, no macro or regex expansion — the packer's
 * verify/shrink step absorbs an optimistic estimate.
 */
export function summaryMessageCost(counter: TokenCounter, preset: Preset) {
  const namesBehavior = preset.names_behavior ?? CHARACTER_NAMES_BEHAVIOR.DEFAULT;
  return (message: ChatMessage): number => {
    const apiMessage: ApiMessage = {
      role: message.is_user ? 'user' : 'assistant',
      content:
        namesBehavior === CHARACTER_NAMES_BEHAVIOR.CONTENT
          ? `${message.name}: ${message.mes}`
          : message.mes,
    };
    if (namesBehavior === CHARACTER_NAMES_BEHAVIOR.COMPLETION) {
      apiMessage.name = sanitizeName(message.name);
    }
    return counter.countChat([apiMessage]) - counter.countChat([]);
  };
}

export interface SummaryPromptInput {
  chatId: string;
  preset: Preset;
  character: CardDataV2;
  persona: Persona | null;
  metadata: ChatMetadata;
  /** The transcript slice this request summarises. */
  candidate: ChatMessage[];
  /** The rolling summary so far, which the request extends. */
  baseSummary: string;
  /** The resolved summary instruction. */
  systemPrompt: string;
  lore: ActivationResult | null;
  guidanceSettings?: GuidanceSettings;
  localVariables: MacroVariableMap;
  globalVariables: MacroVariableMap;
  countTokens: TokenCounter;
  /** The summary's own reply allowance. */
  maxTokens: number;
  regexScripts?: readonly RegexScript[];
}

/**
 * The Classic prompt for one chunk: the chat's own prompt with the transcript slice, then the
 * rolling summary to build on, then the instruction. Regex scripts run as they do for a reply,
 * because the summary has to describe the transcript the model was actually shown.
 */
export function assembleSummaryPrompt(input: SummaryPromptInput) {
  const { metadata, lore, candidate } = input;
  const baseControl = summaryBaseControl(input.baseSummary);
  return assemblePrompt({
    preset: input.preset,
    character: input.character,
    persona: input.persona,
    messages: candidate,
    worldInfoBefore: lore?.before,
    worldInfoAfter: lore?.after,
    worldInfoDepth: lore?.depth,
    scenarioOverride: typeof metadata.scenario === 'string' ? metadata.scenario : undefined,
    authorNote: metadata.authorNote,
    guides: metadata.guides,
    guidanceSettings: input.guidanceSettings,
    localVariables: input.localVariables,
    globalVariables: input.globalVariables,
    countTokens: input.countTokens,
    finalControls: [
      ...(baseControl
        ? [{ identifier: 'summaryBase', role: 'system' as const, content: baseControl }]
        : []),
      { identifier: 'summaryRequest', role: 'system', content: input.systemPrompt },
    ],
    reservedCompletionTokens: input.maxTokens,
    requireChatHistory: true,
    seed: `${input.chatId}:summary:${candidate.at(-1)?.id ?? 'fixed'}`,
    regexScripts: input.regexScripts,
  });
}
