/**
 * The classic summary: what it owes, the paid loop that writes it chunk by chunk, rewrites,
 * undo, the automatic run, and hiding what it covers.
 *
 * It runs on its own `GenerationSlot`, apart from replies: a summary has its own model and
 * Stop, but the two never run at once — each refuses while the other is in flight. What a
 * request carries is pure (`summary/request.ts`); what is covered is pure too
 * (`summary/coverage.ts`).
 */

import { DEFAULT_USER_NAME } from '@shared/prompt/assemble.ts';
import { resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { MacroVariableMap, StorySummary } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { MemoryMode, SummarySettings } from '@shared/types/settings.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type GenerationSlot, runGeneration } from '../../lib/generation.ts';
import { resolveModelContext } from '../models/modelContext.ts';
import {
  messagesToHide,
  restoredSummary,
  summarisable,
  summaryCoverage,
  undoneSummary,
  withHistory,
  writtenSummary,
} from '../summary/coverage.ts';
import {
  linesThatFit,
  summaryCast,
  summaryInstructions,
  summaryMessages,
  summaryPreset,
  summaryReserve,
  transcriptLines,
} from '../summary/request.ts';
import { type ChatAction, chatReducer, toChatMessages } from './state/chatReducer.ts';
import type { ChatSession } from './useChatSession.ts';

/** Update folds in what's new; rewrite starts over from the first message. */
export type SummaryMode = 'update' | 'rewrite';

export interface SummaryRunStatus {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
  mode: SummaryMode;
  /** Started by itself, after a reply, rather than by a click. */
  auto: boolean;
}

const IDLE: SummaryRunStatus = {
  running: false,
  processed: 0,
  total: 0,
  error: null,
  mode: 'update',
  auto: false,
};

export interface ChatSummaryOptions {
  session: ChatSession;
  /** The summary's own slot — its Stop, apart from the chat's. */
  slot: GenerationSlot;
  characterId: string | null;
  character: CardDataV2 | null;
  /** Only to resolve the greeting's macros as the chat shows them. Never sent. */
  preset: Preset | null;
  /** The `summary` slot's model, or null when it cannot run. */
  summaryConnection?: ResolvedModel | null;
  /** Why it cannot run, shown when someone asks for a summary anyway. */
  summaryBlockedReason?: string | null;
  summarySettings?: SummarySettings;
  summaryCountTokens?: TokenCounter;
  globalVariables: MacroVariableMap;
  regexScripts?: readonly RegexScript[];
  /** The chat's memory: the automatic run only works for the classic summary. */
  memoryMode: MemoryMode;
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
    globalVariables,
    regexScripts,
    memoryMode,
  } = options;
  const { state, dispatch, stateRef, messages, persona, captureSnapshot, persistence } = session;
  const { refreshChats } = session;

  const [summaryStatus, setSummaryStatus] = useState<SummaryRunStatus>(IDLE);
  /** Which chat the run in flight belongs to: a switch to another chat stops it. */
  const runningChatId = useRef<string | null>(null);
  /** A chat whose automatic run failed: it never retries by itself. */
  const autoFailed = useRef<string | null>(null);

  const coverage = useMemo(
    () => summaryCoverage(summarisable(messages), state.metadata.summary),
    [messages, state.metadata.summary],
  );

  /** Write the summary into the chat now, and make it durable before anything else is paid. */
  const commitSummary = useCallback(
    async (summary: StorySummary | undefined) => {
      const action: ChatAction = { type: 'chat/metadata', patch: { summary } };
      // Folded from the freshest state, so chat activity during a request is kept.
      const next = chatReducer(stateRef.current, action);
      stateRef.current = next;
      dispatch(action);
      const snapshot = captureSnapshot(next);
      if (snapshot) {
        persistence.schedule(snapshot);
        await persistence.flush(snapshot.chatId);
      }
    },
    [dispatch, stateRef, captureSnapshot, persistence],
  );

  const editSummary = useCallback(
    (text: string) => {
      const current = stateRef.current;
      if (!current.chatId) return;
      const existing = current.metadata.summary;
      // Written by hand over a summary that covered nothing yet: take it as covering the
      // chat as it stands, the way the old checkpoint did.
      const covered =
        existing?.covered ??
        summaryCoverage(summarisable(toChatMessages(current)), existing).fingerprints;
      const fresh = covered.length
        ? covered
        : writtenSummary(undefined, text, [], summarisable(toChatMessages(current)), new Date())
            .covered;
      dispatch({
        type: 'chat/metadata',
        patch: {
          summary: text.trim()
            ? { ...existing, text, covered: fresh, checkpointMessageId: undefined }
            : { ...existing, text: '' },
        },
      });
    },
    [dispatch, stateRef],
  );

  const undoSummary = useCallback(() => {
    if (slot.busy) return;
    const undone = undoneSummary(stateRef.current.metadata.summary);
    if (undone) void commitSummary(undone);
  }, [slot, stateRef, commitSummary]);

  /** Bring back version `index` of the history; the current one goes into history. */
  const restoreSummary = useCallback(
    (index: number) => {
      if (slot.busy) return;
      const restored = restoredSummary(stateRef.current.metadata.summary, index);
      if (restored) void commitSummary(restored);
    },
    [slot, stateRef, commitSummary],
  );

  const cancelSummary = useCallback(() => slot.abort(), [slot]);

  const summarize = useCallback(
    async (settingsOverride?: SummarySettings, mode: SummaryMode = 'update', auto = false) => {
      if (slot.busy) return;
      const current = stateRef.current;
      if (!current.chatId || current.status !== 'idle' || !character || !summarySettings) return;
      if (!summaryCountTokens) return;
      if (!summaryConnection) {
        setSummaryStatus({
          ...IDLE,
          mode,
          error: summaryBlockedReason ?? 'Choose a summary model.',
        });
        return;
      }
      if (!auto) autoFailed.current = null;
      const chatId = current.chatId;
      const settings = settingsOverride ?? summarySettings;
      const counter = summaryCountTokens;
      const fail = (error: string, total = 0) => {
        if (auto) autoFailed.current = chatId;
        setSummaryStatus({ ...IDLE, mode, auto, total, error });
      };

      // Coverage is the stored text; the greeting is sent as the chat shows it, macros
      // filled in, but fingerprinted as stored so it matches everywhere else.
      const raw = toChatMessages(current);
      const all = summarisable(raw);
      const greeting = raw[0] && !raw[0].is_user && preset ? raw[0] : null;
      const greetingText = greeting
        ? resolveGreetingMacros(greeting.mes, {
            character,
            preset: preset as Preset,
            persona,
            messages: raw,
            metadata: current.metadata,
            globalVariables,
            seed: chatId,
          }).trim()
        : '';
      const existing = current.metadata.summary;
      const start = summaryCoverage(all, existing);
      const todo = mode === 'rewrite' ? all : start.backlog;
      if (!todo.length) {
        fail(
          mode === 'rewrite' ? 'There is nothing to summarise yet.' : 'Nothing new to summarise.',
        );
        return;
      }

      const cast = summaryCast(character, persona, DEFAULT_USER_NAME);
      const instructions = summaryInstructions(settings.prompt, settings.targetWords, cast);
      if (!instructions.trim()) {
        fail('The summary prompt is empty.', todo.length);
        return;
      }
      // As much as the model takes: the whole backlog goes in one request when it fits.
      const context = await resolveModelContext(summaryConnection);
      if (slot.busy || stateRef.current.chatId !== chatId) return;
      const budget = context - summaryReserve(settings);
      const entries = transcriptLines(
        todo.map((message) =>
          message.id === greeting?.id && greetingText ? { ...message, mes: greetingText } : message,
        ),
        regexScripts,
      );
      const position = new Map(todo.map((message, index) => [message.id, index]));

      const claim = slot.claim();
      runningChatId.current = chatId;
      const stopped = () => claim.signal.aborted || stateRef.current.chatId !== chatId;
      let processed = 0;
      // The version this run replaces goes into history once, before the first chunk.
      let summary = withHistory(existing);
      let memory = mode === 'rewrite' ? '' : (existing?.text ?? '');
      let covered: string[] = mode === 'rewrite' ? [] : start.fingerprints;
      let entryAt = 0;
      let messageAt = 0;
      setSummaryStatus({ ...IDLE, running: true, total: todo.length, mode, auto });

      try {
        while (messageAt < todo.length) {
          const remaining = entries.slice(entryAt);
          const build = (lines: readonly string[]) =>
            summaryMessages({ instructions, cast, memory, lines });
          let take = 0;
          if (remaining.length) {
            take = linesThatFit({
              lines: remaining.map((entry) => entry.line),
              budget,
              counter,
              build,
            });
            if (take === 0) {
              throw new Error(
                `The next message doesn’t fit beside the memory so far in the model’s ${context.toLocaleString()} tokens. Lower the summary’s length.`,
              );
            }
          }
          // The chunk runs through the last message it sends; messages a regex script emptied
          // ride along with their neighbours, and the last chunk takes any left at the end.
          const last = remaining[take - 1];
          const through =
            entryAt + take >= entries.length
              ? todo.length
              : (position.get(last?.message.id ?? '') ?? messageAt) + 1;
          const chunk = todo.slice(messageAt, through);

          let text = memory;
          if (take > 0) {
            const body = buildRequestBody({
              messages: build(remaining.slice(0, take).map((entry) => entry.line)),
              preset: summaryPreset(settings, context),
              connection: summaryConnection,
              stream: false,
              maxTokens: null,
              completions: 1,
            });
            const result = await runGeneration({
              model: summaryConnection,
              body,
              signal: claim.signal,
              usage: {
                feature: 'summary',
                sessionId: chatId,
                ...(characterId ? { character: characterId } : {}),
                countText: counter.countText,
              },
              onTick: () => {},
            });
            text = result.content.trim();
            if (!text) throw new Error('The summary model sent back nothing.');
          }
          if (stopped()) return;

          summary = writtenSummary(summary, text, covered, chunk, new Date());
          covered = summary.covered ?? [];
          memory = text;
          entryAt += take;
          messageAt = through;
          processed += chunk.length;
          await commitSummary(summary);
          setSummaryStatus({
            ...IDLE,
            running: messageAt < todo.length,
            processed,
            total: todo.length,
            mode,
            auto,
          });
        }

        // Once covered, older messages can leave the prompt: the summary stands in for them.
        if (settings.hideCovered && !stopped()) {
          const ids = messagesToHide(
            toChatMessages(stateRef.current),
            covered,
            settings.keepMessages,
          );
          if (ids.length) {
            const action: ChatAction = { type: 'message/hideForSummary', ids };
            const next = chatReducer(stateRef.current, action);
            stateRef.current = next;
            dispatch(action);
            const snapshot = captureSnapshot(next);
            if (snapshot) {
              persistence.schedule(snapshot);
              await persistence.flush(snapshot.chatId);
            }
          }
        }
      } catch (error) {
        if (!claim.signal.aborted) {
          if (auto) autoFailed.current = chatId;
          setSummaryStatus({
            ...IDLE,
            processed,
            total: todo.length,
            error: (error as Error).message,
            mode,
            auto,
          });
        }
      } finally {
        claim.release();
        if (runningChatId.current === chatId) runningChatId.current = null;
        if (claim.signal.aborted) {
          setSummaryStatus({ ...IDLE, processed, total: todo.length, mode, auto });
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
      captureSnapshot,
      persistence,
      refreshChats,
      dispatch,
      stateRef,
      commitSummary,
    ],
  );

  /*
   * The automatic run: once enough new messages wait, right after a reply settles. Only on
   * growth seen in this chat, so opening an old chat with a long backlog never starts a paid
   * run by itself, and a failure waits for a click rather than retrying.
   */
  const lastIdle = useRef<{ chatId: string; count: number } | null>(null);
  const autoAfter = summarySettings?.auto ? summarySettings.autoAfter : 0;
  const pending = coverage.backlog.length;
  useEffect(() => {
    const chatId = state.chatId;
    if (!chatId || state.status !== 'idle') return;
    const seen = lastIdle.current;
    lastIdle.current = { chatId, count: messages.length };
    if (!seen || seen.chatId !== chatId || messages.length <= seen.count) return;
    if (memoryMode !== 'classic' || autoAfter <= 0 || pending < autoAfter) return;
    if (slot.busy || autoFailed.current === chatId || !summaryConnection) return;
    void summarize(undefined, 'update', true);
  }, [
    state.chatId,
    state.status,
    messages.length,
    memoryMode,
    autoAfter,
    pending,
    slot,
    summaryConnection,
    summarize,
  ]);

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

  return {
    summaryStatus,
    summaryPending: coverage.backlog.length,
    /** Summarised messages that have changed since: edited, re-swiped or added between. */
    summaryChanged: coverage.changed,
    summaryCovered: coverage.covered,
    summaryCanUndo: Boolean(state.metadata.summary?.history?.length),
    summarize,
    undoSummary,
    restoreSummary,
    cancelSummary,
    editSummary,
    onChatChanged,
  };
}

export type ChatSummaryControls = ReturnType<typeof useChatSummary>;
