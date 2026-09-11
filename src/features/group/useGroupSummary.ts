import { publicCast } from '@shared/group/director.ts';
import { assemblePrompt } from '@shared/prompt/assemble.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ChatMessage, StorySummary } from '@shared/types/chat.ts';
import type { SummarySettings } from '@shared/types/settings.ts';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamGenerate } from '../../lib/api.ts';
import { encodingForModel, loadCounter } from '../../lib/tokenizer.ts';
import {
  packClassicSummaryChunk,
  resolveSummaryPrompt,
  summaryBacklog,
  summaryMessages,
} from '../summary/summary.ts';
import { completedGroupMessages, type GroupAction, type GroupState } from './groupReducer.ts';

export function useGroupSummary(
  state: GroupState,
  stateRef: RefObject<GroupState>,
  dispatch: (a: GroupAction) => void,
  settings: SummarySettings,
  connection: Connection | null,
  save: () => Promise<void>,
) {
  const abort = useRef<AbortController | null>(null);
  const [summaryStatus, setStatus] = useState({
    running: false,
    processed: 0,
    total: 0,
    error: null as string | null,
  });
  // The unsummarised count shows in the memory panel; recomputing it on every render of
  // the scene walks the whole transcript twice (projection, then backlog), so it is keyed
  // on the inputs it actually reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projection of messages, jobs and summary only
  const pending = useMemo(
    () =>
      summaryBacklog(summaryMessages(completedGroupMessages(state)), state.metadata.summary).length,
    [state.messages, state.jobs, state.metadata.summary],
  );
  const cancelSummary = useCallback(() => abort.current?.abort(), []);
  useEffect(() => {
    return () => abort.current?.abort();
  }, [state.chatId]);
  const summarize = useCallback(
    async (override?: SummarySettings) => {
      const current = structuredClone(stateRef.current);
      if (
        !current.chatId ||
        current.status !== 'idle' ||
        abort.current ||
        !connection ||
        !current.metadata.group
      )
        return;
      const config = override ?? settings;
      const controller = new AbortController();
      abort.current = controller;
      const backlog = summaryBacklog(
        summaryMessages(completedGroupMessages(current)),
        current.metadata.summary,
      );
      let remaining = backlog;
      let rolling = current.metadata.summary?.text ?? '';
      let processed = 0;
      setStatus({ running: true, processed, total: backlog.length, error: null });
      try {
        const counter = await loadCounter(encodingForModel(connection.model));
        const maxTokens = Math.ceil(config.targetWords * 2);
        const preset = {
          ...createDefaultPreset(),
          openai_max_context: current.metadata.group.director.contextTokens,
          openai_max_tokens: maxTokens,
          names_behavior: 2 as const,
        };
        // A shared summarizer sees public scene knowledge, never an arbitrarily chosen member's private card.
        const card: CardDataV2 = {
          name: 'Scene archivist',
          description: publicCast(current.metadata.group),
          scenario: current.metadata.group.scenario,
          personality: '',
          first_mes: '',
          mes_example: '',
          creator_notes: '',
          system_prompt: '',
          post_history_instructions: '',
          alternate_greetings: [],
          tags: [],
          creator: '',
          character_version: '',
          extensions: {},
        };
        while (remaining.length && !controller.signal.aborted) {
          const assemble = (messages: ChatMessage[]) =>
            assemblePrompt({
              character: card,
              preset,
              messages,
              countTokens: counter,
              requireChatHistory: true,
              memoryMode: 'off',
              reservedCompletionTokens: maxTokens,
              finalControls: [
                {
                  identifier: 'summary',
                  role: 'system',
                  content: `Existing summary:\n${rolling}\n${resolveSummaryPrompt(config.prompt, config.targetWords)}\nSummarize the entire ensemble, preserving who did and said what. Do not continue the scene.`,
                },
              ],
            });
          const base = assemble([]);
          if (!base.ok) throw new Error('Summary instructions exceed context.');
          const chunk = await packClassicSummaryChunk({
            messages: remaining,
            maxPromptTokens: preset.openai_max_context - maxTokens,
            fixedTokens: base.totalTokens,
            messageCost: (m) =>
              counter.countChat([
                { role: m.is_user ? 'user' : 'assistant', content: `${m.name}: ${m.mes}` },
              ]) - counter.countChat([]),
            assemble,
          });
          if (!chunk)
            throw new Error(
              'The next message cannot fit in the summary context. Increase group context or shorten the summary.',
            );
          const result = await streamGenerate(
            buildRequestBody({
              messages: chunk.assembled.messages,
              preset,
              connection,
              stream: false,
              completions: 1,
            }),
            controller.signal,
            { onTick() {} },
            '',
            connection.id,
            { feature: 'summary', sessionId: current.chatId, countText: counter.countText },
          );
          if (controller.signal.aborted || stateRef.current.chatId !== current.chatId) return;
          if (!result.content.trim() || result.finishReason === 'length')
            throw new Error('Summary was empty or truncated; the checkpoint was not advanced.');
          rolling = result.content.trim();
          processed += chunk.messages.length;
          remaining = remaining.slice(chunk.messages.length);
          dispatch({
            type: 'chat/metadata',
            patch: { summary: { text: rolling, checkpointMessageId: chunk.messages.at(-1)!.id } },
          });
          await save();
          setStatus({ running: true, processed, total: backlog.length, error: null });
        }
        setStatus({ running: false, processed, total: backlog.length, error: null });
      } catch (error) {
        setStatus({
          running: false,
          processed,
          total: backlog.length,
          error: controller.signal.aborted ? null : (error as Error).message,
        });
      } finally {
        abort.current = null;
        setStatus((s) => ({ ...s, running: false }));
      }
    },
    [connection, dispatch, save, settings, stateRef],
  );
  const editSummary = (text: string) => {
    const prior = stateRef.current.metadata.summary;
    const summary: StorySummary = text.trim() ? { ...prior, text } : { text: '' };
    dispatch({ type: 'chat/metadata', patch: { summary } });
  };
  return {
    summaryStatus,
    summaryPending: pending,
    summarize,
    cancelSummary,
    editSummary,
    summaryAbort: abort,
  };
}
