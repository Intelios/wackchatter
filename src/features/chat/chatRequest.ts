/**
 * The pure half of a chat generation: what to send, and what to record once it answered.
 *
 * `useChatGeneration` owns the order things happen in — placeholder, lore, recall, macro
 * commits, the stream — and everything in between that does not touch React, the network or
 * a ref lives here, where it can be tested without a DOM: the prompt and request body, the
 * inspection the Prompt Inspector shows, and the reply metadata, including the rules for when
 * a token count is the provider's own.
 */

import { currentText, type MessageState } from '@shared/chat/message.ts';
import { reportNexusAssembly } from '@shared/nexus/report.ts';
import type { NexusRecall, NexusSettings } from '@shared/nexus/types.ts';
import { assemblePrompt } from '@shared/prompt/assemble.ts';
import { DEFAULT_IMPERSONATION_PROMPT } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { StreamState } from '@shared/providers/sse.ts';
import type { ChatCompletionBody, ResolvedModel } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { MacroVariableMap, MessageExtra, Persona } from '@shared/types/chat.ts';
import type { GenerationType, Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { GuidanceSettings, MemoryMode, SummarySettings } from '@shared/types/settings.ts';
import type { ActivationResult } from '@shared/worldinfo/activate.ts';
import {
  type ChatState,
  type GeneratedAlternate,
  type GenMode,
  type PromptInspection,
  toChatMessages,
} from './state/chatReducer.ts';

export const MODE_TO_GENERATION_TYPE: Record<GenMode, GenerationType> = {
  send: 'normal',
  regenerate: 'regenerate',
  swipe: 'swipe',
  continue: 'continue',
  impersonate: 'impersonate',
};

/**
 * The text a generation builds on: the reply so far for `continue`, joined by the preset's
 * postfix — which has to match the one assembly puts in the prefill, or the two halves join
 * differently from how the model saw them. Empty for every other mode.
 */
export function continueSeed(mode: GenMode, target: MessageState | undefined, preset: Preset) {
  return mode === 'continue' && target
    ? `${currentText(target)}${preset.continue_postfix ?? ' '}`
    : '';
}

/**
 * How many completions to ask for. Extra completions become extra swipes, so only the modes
 * that own a swipe array get them: `continue` writes into one existing swipe and has nowhere
 * to put a second take of the same half-finished sentence, and impersonation writes the one
 * message the user is about to send — which is why SillyTavern excludes it from multi-swipe.
 */
export function completionsFor(mode: GenMode, preset: Preset): number {
  return mode === 'continue' || mode === 'impersonate' ? 1 : Math.max(1, Math.trunc(preset.n ?? 1));
}

export interface ChatRequestInput {
  mode: GenMode;
  /** The state with the placeholder already folded in — its empty text keeps it out. */
  started: ChatState;
  model: ResolvedModel;
  preset: Preset;
  character: CardDataV2;
  persona: Persona | null;
  lore: ActivationResult | null;
  nexusRecall: NexusRecall | undefined;
  memoryMode: MemoryMode;
  nexusSettings: NexusSettings;
  summarySettings?: SummarySettings;
  /** One-shot guided-generation text, already resolved at the composer chokepoint. */
  guidance?: string;
  guidanceSettings?: GuidanceSettings;
  globalVariables: MacroVariableMap;
  countTokens: TokenCounter;
  regexScripts?: readonly RegexScript[];
}

export type ChatRequest =
  | {
      ok: false;
      /** Shown in the Prompt Inspector, so an overflow can be read rather than guessed at. */
      inspection: PromptInspection;
      message: string;
    }
  | {
      ok: true;
      assembled: Extract<ReturnType<typeof assemblePrompt>, { ok: true }>;
      body: ChatCompletionBody;
      inspection: PromptInspection;
      completions: number;
      streamed: boolean;
      nexusRecall: NexusRecall | undefined;
    };

/** Assemble the prompt and the request body for one chat generation. */
export function prepareChatRequest(input: ChatRequestInput): ChatRequest {
  const { mode, started, preset, lore } = input;
  const generationType = MODE_TO_GENERATION_TYPE[mode];

  // SillyTavern's impersonation control prompt: the model's closest instruction, appended
  // after everything else the request carries. `{{user}}` here is who it is being asked to
  // become, so the control opts into macro substitution. A field the user cleared to empty
  // sends nothing at all, matching ST's falsy check.
  const impersonationPrompt =
    mode === 'impersonate' ? (preset.impersonation_prompt ?? DEFAULT_IMPERSONATION_PROMPT) : '';

  const assembled = assemblePrompt({
    preset,
    character: input.character,
    persona: input.persona,
    messages: toChatMessages(started),
    generationType,
    worldInfoBefore: lore?.before,
    worldInfoAfter: lore?.after,
    worldInfoDepth: lore?.depth,
    memoryMode: input.memoryMode,
    memoryText: input.nexusRecall?.text,
    memorySettings: input.nexusSettings,
    scenarioOverride:
      typeof started.metadata.scenario === 'string' ? started.metadata.scenario : undefined,
    authorNote: started.metadata.authorNote,
    summary: started.metadata.summary,
    summarySettings: input.summarySettings,
    guides: started.metadata.guides,
    // One-shot: it exists only as an argument on this call, so unlike an ephemeral injection
    // parked in metadata there is nothing that could leak into the next generation, or
    // survive a failure that skipped its own cleanup.
    guidance: input.guidance,
    guidanceSettings: input.guidanceSettings,
    localVariables: started.metadata.variables ?? {},
    globalVariables: input.globalVariables,
    countTokens: input.countTokens,
    finalControls: impersonationPrompt.trim()
      ? [{ identifier: 'impersonate', role: 'system', content: impersonationPrompt, macros: true }]
      : undefined,
    seed: started.chatId ?? '',
    regexScripts: input.regexScripts,
  });

  const nexusRecall = reportNexusAssembly(input.nexusRecall, assembled);
  const inspected = {
    at: Date.now(),
    nexusRecall,
    generationType,
    messages: assembled.messages,
    tokenCounts: assembled.tokenCounts,
    totalTokens: assembled.totalTokens,
    droppedMessages: assembled.droppedMessages,
    macroWarnings: assembled.macroWarnings,
  };

  if (!assembled.ok) {
    const { requiredPromptTokens, maxContext, reservedCompletionTokens } = assembled.error;
    return {
      ok: false,
      inspection: { ...inspected, body: null, overflow: assembled.error },
      message: `Context overflow: mandatory prompt content needs ${requiredPromptTokens} tokens, but only ${maxContext - reservedCompletionTokens} are available.`,
    };
  }

  const completions = completionsFor(mode, preset);
  const streamed = preset.stream_openai !== false;
  const body = buildRequestBody({
    messages: assembled.messages,
    preset,
    connection: input.model,
    stream: streamed,
    completions,
  });

  return {
    ok: true,
    assembled,
    body,
    inspection: { ...inspected, body },
    completions,
    streamed,
    nexusRecall,
  };
}

export interface ReplyRecord {
  final: StreamState;
  model: ResolvedModel;
  presetId: string | null | undefined;
  nexusRecall: NexusRecall | undefined;
  generationId: string;
  completions: number;
  countText: (text: string) => number;
}

/**
 * What a finished reply records: its metadata, and its alternates as further swipes.
 *
 * A provider's own token count beats our estimate when we get one — but reported usage
 * covers every completion in the request, so once there are alternates it is no longer this
 * swipe's count and the estimate is closer. `usage_reported` is set only when the count is
 * genuinely this swipe's.
 */
export function recordReply(input: ReplyRecord): {
  extra: MessageExtra;
  alternates: GeneratedAlternate[];
} {
  const { final, model, presetId, nexusRecall, countText } = input;
  const common = {
    nexusRecall,
    api: model.provider,
    model: final.model ?? model.model,
    connection_id: model.id,
    ...(presetId ? { preset_id: presetId } : {}),
  };

  // Blank ones are dropped: a provider may honour `n` with fewer completions than asked for,
  // and an empty swipe is just something to skip past. Only trusted when this request
  // actually asked for alternates.
  const alternates: GeneratedAlternate[] =
    input.completions > 1
      ? (final.alternates ?? [])
          .filter((choice) => choice.content.trim())
          .map((choice) => ({
            text: choice.content,
            finishReason: choice.finishReason,
            extra: {
              ...common,
              ...(choice.reasoning ? { reasoning: choice.reasoning } : {}),
              token_count: countText(choice.content),
            },
          }))
      : [];

  const reported = !alternates.length && typeof final.usage?.completion_tokens === 'number';
  return {
    alternates,
    extra: {
      ...common,
      // Only ever the provider's own number. An estimate here would be missing whatever world
      // info and injections the request actually carried, and a wrong prompt count is worse
      // than none.
      ...(typeof final.usage?.prompt_tokens === 'number'
        ? { prompt_tokens: final.usage.prompt_tokens }
        : {}),
      ...(final.reasoning ? { reasoning: final.reasoning } : {}),
      token_count: reported ? (final.usage?.completion_tokens as number) : countText(final.content),
      // Identity for this generation, shared with the usage log so the two can be reconciled
      // without matching on text or timestamps.
      generation_id: input.generationId,
      ...(reported ? { usage_reported: true } : {}),
    },
  };
}
