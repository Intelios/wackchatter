/**
 * The Classic rolling summary: the backlog it owes, the paid loop that writes it chunk by
 * chunk, and manual edits.
 *
 * It runs on its own `GenerationSlot`, apart from replies: a summary is not the chat model
 * and has its own Stop, but the two never run at once — each refuses while the other is in
 * flight. What a chunk is sent with is pure (`summary/summaryPrompt.ts`).
 */

import { resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import { responseReserve } from '@shared/providers/responseLength.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ChatMessage, MacroVariableMap } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { GuidanceSettings, SummarySettings } from '@shared/types/settings.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '@shared/types/worldinfo.ts';
import type { WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { useCallback, useMemo, useRef, useState } from 'react';
import { type GenerationSlot, runGeneration } from '../../lib/generation.ts';
import { worldInfoForChat } from '../lore/worldInfoForChat.ts';
import {
  packClassicSummaryChunk,
  resolveSummaryPrompt,
  summaryBacklog,
  summaryMessages,
  yieldToMain,
} from '../summary/summary.ts';
import { assembleSummaryPrompt, summaryMessageCost } from '../summary/summaryPrompt.ts';
import { type ChatAction, chatReducer, toChatMessages } from './state/chatReducer.ts';
import type { ChatSession } from './useChatSession.ts';

export interface SummaryRunStatus {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
}

const IDLE: SummaryRunStatus = { running: false, processed: 0, total: 0, error: null };

export interface ChatSummaryOptions {
  session: ChatSession;
  /** The summary's own slot — its Stop, apart from the chat's. */
  slot: GenerationSlot;
  characterId: string | null;
  character: CardDataV2 | null;
  preset: Preset | null;
  /** The `summary` slot's model, or null when it cannot run. */
  summaryConnection?: ResolvedModel | null;
  /** Why it cannot run, shown when someone asks for a summary anyway. */
  summaryBlockedReason?: string | null;
  summarySettings?: SummarySettings;
  summaryCountTokens?: TokenCounter;
  worldInfoSources?: WorldInfoSource[];
  resolveWorldInfoSources?: (personaLorebookId?: string) => WorldInfoSource[];
  worldInfoSettings?: WorldInfoSettings;
  guidanceSettings?: GuidanceSettings;
  globalVariables: MacroVariableMap;
  regexScripts?: readonly RegexScript[];
  onGlobalVariablesChange: (variables: MacroVariableMap) => Promise<void>;
}

export function useChatSummary(options: ChatSummaryOptions) {
  const {
    session,
    slot,
    characterId,
    character,
    preset,
    summaryConnection,
    summaryBlockedReason,
    summarySettings,
    summaryCountTokens,
    worldInfoSources,
    resolveWorldInfoSources,
    worldInfoSettings,
    guidanceSettings,
    globalVariables,
    regexScripts,
    onGlobalVariablesChange,
  } = options;
  const { state, dispatch, stateRef, messages, persona, captureSnapshot, persistence } = session;
  const { refreshChats } = session;

  const [summaryStatus, setSummaryStatus] = useState<SummaryRunStatus>(IDLE);
  /** Which chat the run in flight belongs to: a switch to another chat stops it. */
  const runningChatId = useRef<string | null>(null);

  const summaryPending = useMemo(
    () => summaryBacklog(summaryMessages(messages), state.metadata.summary).length,
    [messages, state.metadata.summary],
  );

  const editSummary = useCallback(
    (text: string) => {
      const current = stateRef.current;
      if (!current.chatId) return;
      const existing = current.metadata.summary;
      const trimmed = text.trim();
      const checkpointMessageId = trimmed
        ? (existing?.checkpointMessageId ?? summaryMessages(toChatMessages(current)).at(-1)?.id)
        : undefined;
      dispatch({
        type: 'chat/metadata',
        patch: { summary: { text, ...(checkpointMessageId ? { checkpointMessageId } : {}) } },
      });
    },
    [dispatch, stateRef],
  );

  const cancelSummary = useCallback(() => slot.abort(), [slot]);

  const summarize = useCallback(
    async (settingsOverride?: SummarySettings) => {
      if (slot.busy) return;
      const current = stateRef.current;
      if (
        !current.chatId ||
        current.status !== 'idle' ||
        !character ||
        !preset ||
        !summarySettings ||
        !summaryCountTokens
      ) {
        return;
      }
      if (!summaryConnection) {
        setSummaryStatus({ ...IDLE, error: summaryBlockedReason ?? 'Choose a summary model.' });
        return;
      }
      const chatId = current.chatId;

      const rawMessages = toChatMessages(current);
      if (rawMessages[0] && !rawMessages[0].is_user) {
        rawMessages[0] = {
          ...rawMessages[0],
          mes: resolveGreetingMacros(rawMessages[0].mes, {
            character,
            preset,
            persona,
            messages: rawMessages,
            metadata: current.metadata,
            globalVariables,
            seed: chatId,
          }),
        };
      }

      const backlog = summaryBacklog(summaryMessages(rawMessages), current.metadata.summary);
      if (!backlog.length) {
        setSummaryStatus({ ...IDLE, error: 'No new chat messages need summarizing.' });
        return;
      }

      const effective = settingsOverride ?? summarySettings;
      const systemPrompt = resolveSummaryPrompt(effective.prompt, effective.targetWords);
      if (!systemPrompt.trim()) {
        setSummaryStatus({ ...IDLE, total: backlog.length, error: 'The summary prompt is empty.' });
        return;
      }

      const claim = slot.claim();
      runningChatId.current = chatId;
      const stopped = () => claim.signal.aborted || stateRef.current.chatId !== chatId;
      let processed = 0;
      let remaining = backlog;
      let rollingSummary = current.metadata.summary?.text ?? '';
      let runLocalVariables = { ...(current.metadata.variables ?? {}) };
      let runGlobalVariables = { ...globalVariables };
      // Room kept free in the context for the summary while packing turns. Never sent as a
      // cap: a thinking model spends tokens before writing, and a cap cut summaries short.
      const maxTokens = Math.max(Math.ceil(effective.targetWords * 2), responseReserve(preset));
      const sources =
        resolveWorldInfoSources?.(persona?.lorebookId ?? undefined) ?? worldInfoSources ?? [];

      const assemble = (candidate: ChatMessage[], baseSummary: string) =>
        assembleSummaryPrompt({
          chatId,
          preset,
          character,
          persona,
          metadata: current.metadata,
          candidate,
          baseSummary,
          systemPrompt,
          lore: worldInfoForChat({
            sources,
            messages: candidate,
            settings: worldInfoSettings ?? DEFAULT_WI_SETTINGS,
            preset,
            chatId,
            countTokens: summaryCountTokens,
          }),
          guidanceSettings,
          localVariables: runLocalVariables,
          globalVariables: runGlobalVariables,
          countTokens: summaryCountTokens,
          maxTokens,
          regexScripts,
        });

      setSummaryStatus({ running: true, processed: 0, total: backlog.length, error: null });
      // Let the progress UI paint before the synchronous pack work begins.
      await yieldToMain();

      try {
        const maxPromptTokens = (preset.openai_max_context ?? 4095) - maxTokens;
        const messageCost = summaryMessageCost(summaryCountTokens, preset);

        while (remaining.length > 0) {
          const fixed = assemble([], '');
          if (!fixed.ok) {
            throw new Error(
              `The fixed Classic prompt and summary instruction need ${fixed.error.requiredPromptTokens} tokens, but only ${fixed.error.maxContext - fixed.error.reservedCompletionTokens} are available. Increase the preset context limit or shorten enabled prompt content.`,
            );
          }
          let fixedTokens = fixed.totalTokens;
          if (rollingSummary.trim()) {
            const withBase = assemble([], rollingSummary);
            if (!withBase.ok) {
              throw new Error(
                'The existing rolling summary does not fit alongside the Classic prompt. Increase the preset context limit, reduce the target length, or shorten the current summary.',
              );
            }
            fixedTokens = withBase.totalTokens;
          }

          const chunk = await packClassicSummaryChunk({
            messages: remaining,
            maxPromptTokens,
            fixedTokens,
            messageCost,
            assemble: (candidate) => assemble(candidate, rollingSummary),
          });
          if (!chunk) {
            throw new Error(
              'The next individual chat turn cannot fit alongside the Classic prompt and rolling summary. Increase the preset context limit, reduce the target length, shorten the current summary, or shorten that turn.',
            );
          }

          const assembled = chunk.assembled;
          if (assembled.variableUpdates.localChanged) {
            runLocalVariables = assembled.variableUpdates.local;
            const action: ChatAction = {
              type: 'chat/metadata',
              patch: { variables: runLocalVariables },
            };
            stateRef.current = chatReducer(stateRef.current, action);
            dispatch(action);
          }
          if (assembled.variableUpdates.globalChanged) {
            runGlobalVariables = assembled.variableUpdates.global;
            await onGlobalVariablesChange(runGlobalVariables);
          }
          if (stopped()) return;

          const body = buildRequestBody({
            messages: assembled.messages,
            preset,
            connection: summaryConnection,
            stream: false,
            maxTokens: null,
          });
          const result = await runGeneration({
            model: summaryConnection,
            body,
            signal: claim.signal,
            usage: {
              feature: 'summary',
              sessionId: chatId,
              ...(characterId ? { character: characterId } : {}),
              countText: summaryCountTokens.countText,
            },
            onTick: () => {},
          });
          const nextSummary = result.content.trim();
          if (!nextSummary) throw new Error('The summary model returned an empty response.');
          if (stopped()) return;

          const checkpointMessageId = chunk.messages.at(-1)!.id;
          rollingSummary = nextSummary;
          processed += chunk.messages.length;
          remaining = remaining.slice(chunk.messages.length);
          const action: ChatAction = {
            type: 'chat/metadata',
            patch: { summary: { text: nextSummary, checkpointMessageId } },
          };
          // A completed chunk is a durable checkpoint before another paid request begins.
          // Fold from the freshest state so chat activity that happened during the request is
          // included in the same snapshot rather than overwritten by the captured input.
          const nextState = chatReducer(stateRef.current, action);
          stateRef.current = nextState;
          dispatch(action);
          const snapshot = captureSnapshot(nextState);
          if (snapshot) {
            persistence.schedule(snapshot);
            await persistence.flush(snapshot.chatId);
          }
          setSummaryStatus({
            running: remaining.length > 0,
            processed,
            total: backlog.length,
            error: null,
          });
        }
      } catch (error) {
        if (!claim.signal.aborted) {
          setSummaryStatus({
            running: false,
            processed,
            total: backlog.length,
            error: (error as Error).message,
          });
        }
      } finally {
        claim.release();
        if (runningChatId.current === chatId) runningChatId.current = null;
        if (claim.signal.aborted) {
          setSummaryStatus({ running: false, processed, total: backlog.length, error: null });
        }
        void refreshChats();
      }
    },
    [
      slot,
      character,
      characterId,
      preset,
      persona,
      summaryConnection,
      summaryBlockedReason,
      summarySettings,
      summaryCountTokens,
      globalVariables,
      regexScripts,
      worldInfoSources,
      resolveWorldInfoSources,
      worldInfoSettings,
      guidanceSettings,
      onGlobalVariablesChange,
      captureSnapshot,
      persistence,
      refreshChats,
      dispatch,
      stateRef,
    ],
  );

  /**
   * A different chat is now open: stop a run that belongs to another one, and clear the
   * status line, which described that chat.
   */
  const onChatChanged = useCallback(
    (chatId: string | null) => {
      if (runningChatId.current && runningChatId.current !== chatId) slot.abort();
      setSummaryStatus(IDLE);
    },
    [slot],
  );

  return { summaryStatus, summaryPending, summarize, cancelSummary, editSummary, onChatChanged };
}

export type ChatSummaryControls = ReturnType<typeof useChatSummary>;
