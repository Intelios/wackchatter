import {
  activeCheckpoint,
  makeCompactionPlan,
  normalizeCompaction,
  shouldCompact,
} from '@shared/cocreator/compaction.ts';
import {
  type CoCreatorReasoningEfforts,
  coCreatorReasoningEffort,
} from '@shared/models/reasoning.ts';
import { resolveModelRef } from '@shared/models/slots.ts';
import type { StreamState } from '@shared/providers/sse.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { Preset, ReasoningEffort } from '@shared/types/preset.ts';
import type {
  PresetCocreatorDocument,
  PresetCocreatorMessage,
  PresetCocreatorSession,
  PresetComparisonSource,
  PresetTestReport,
  PublishPresetDraftRequest,
  ReplacePresetDraftRequest,
} from '@shared/types/preset-cocreator.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, presetCocreatorApi, referencePresetApi } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';
import { runGeneration } from '../../lib/generation.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import { createStreamStore } from '../chat/state/streamStore.ts';
import { runCompaction } from '../cocreator/compactionRun.ts';
import { contextView } from '../cocreator/context.ts';
import { resolveModelContext } from '../models/modelContext.ts';
import { useModelContext } from '../models/useModelContext.ts';
import {
  ASSISTANT_REQUEST_LIMIT,
  assistantResponseMessage,
  editAssistantConversationMessage,
  presetIdentity,
  referencePresetView,
  rejectComparisonToolCalls,
  UnconfirmedPresetPatchError,
} from './assistant.ts';
import { buildAssistantRequest } from './assistantRequest.ts';
import { loadComparisonPreset } from './compareSources.ts';
import {
  batchConversationMessage,
  buildPresetTestBatch,
  reportConversationMessage,
} from './testing.ts';
import { executePresetToolBatch } from './toolExecution.ts';

/** What a reply used, for the session's cost: the provider's count when it gave one. */
function messageUsage(
  state: StreamState,
  model: { id: string; model: string },
): Pick<PresetCocreatorMessage, 'usage'> {
  const input = state.usage?.prompt_tokens;
  const output = state.usage?.completion_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return {};
  return {
    usage: {
      connectionId: model.id,
      model: state.model ?? model.model,
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
    },
  };
}

interface DocumentSnapshot {
  document: PresetCocreatorDocument;
  operationId: string;
}

export interface UsePresetCocreatorOptions {
  initial: PresetCocreatorSession;
  connections: readonly Connection[];
  coCreatorReasoningEfforts?: CoCreatorReasoningEfforts;
  modelSaving?: boolean;
  streamingFps: number;
  referenceNames?: readonly string[];
}

export function usePresetCocreator({
  initial,
  connections,
  coCreatorReasoningEfforts,
  modelSaving = false,
  streamingFps,
  referenceNames = [],
}: UsePresetCocreatorOptions) {
  const effortsRef = useRef(coCreatorReasoningEfforts);
  effortsRef.current = coCreatorReasoningEfforts;
  const modelSavingRef = useRef(modelSaving);
  modelSavingRef.current = modelSaving;
  const [session, setSessionState] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [batchSending, setBatchSending] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef(session);
  const serverDocumentRevision = useRef(new Map<string, number>());
  const abortRef = useRef<AbortController | null>(null);
  const workDone = useRef<Promise<void> | null>(null);
  const preparingComparison = useRef(false);
  const preparingBatch = useRef(false);

  // The streaming hot path, same bargain as the chat: the growing text never enters
  // React state, it lives in this store and reaches one leaf (the StreamingBubble)
  // through useSyncExternalStore, so a streamed reply re-renders nothing else. Recreated
  // only when the rate changes, so a running stream keeps its store.
  const stream = useMemo(() => createStreamStore(streamingFps), [streamingFps]);

  const setSession = useCallback((next: PresetCocreatorSession) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  const queueRef = useRef<AutosaveQueue<DocumentSnapshot, PresetCocreatorSession> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new AutosaveQueue<DocumentSnapshot, PresetCocreatorSession>(
      async (id, snapshot) => {
        const expectedRevision = serverDocumentRevision.current.get(id);
        if (expectedRevision === undefined) throw new Error('The session document is not loaded.');
        const saved = await presetCocreatorApi.saveDocument(id, {
          expectedRevision,
          operationId: snapshot.operationId,
          document: snapshot.document,
        });
        serverDocumentRevision.current.set(id, saved.documentRevision);
        return saved;
      },
      350,
      {
        onSaved: (_id, snapshot, saved) => {
          const current = sessionRef.current;
          if (current.id !== saved.id) return;
          setSession({
            ...current,
            modified: saved.modified,
            documentRevision: saved.documentRevision,
            document: snapshot.document,
            // A patch may commit even if its response was lost. The document-save reply
            // also carries the server's operation receipts; adopt them before continuing.
            ...(saved.draftRevision >= current.draftRevision
              ? {
                  draftRevision: saved.draftRevision,
                  current: saved.current,
                  history: saved.history,
                }
              : {}),
          });
          setError(null);
        },
        onFailed: (_id, failure) => setError(failure.message),
        onPendingChange: setSaving,
      },
    );
  }
  const queue = queueRef.current;

  useEffect(() => {
    // Adopt once per session. A parent refresh (including hot reload) may still carry
    // the original document; it must not replace newer messages or checkpoints.
    if (sessionRef.current.id === initial.id && serverDocumentRevision.current.has(initial.id))
      return;
    setSession(initial);
    serverDocumentRevision.current.set(initial.id, initial.documentRevision);
    queue.adopt(initial.id, 0);
  }, [initial, queue, setSession]);

  /**
   * The one way the session document changes. Updaters are pure, targeted edits — they
   * spread the path they touch and share every other subtree with the previous document.
   * That is what makes a per-keystroke composer draft cheap: the session holds megabytes
   * of immutable test transcripts and evidence, and neither the update nor the queued
   * save copies any of it (`scheduleImmutable` stores the document by reference, which
   * only stays correct while updaters never mutate in place).
   */
  const updateDocument = useCallback(
    (
      update:
        | PresetCocreatorDocument
        | ((current: PresetCocreatorDocument) => PresetCocreatorDocument),
    ): PresetCocreatorDocument => {
      const current = sessionRef.current;
      const document = typeof update === 'function' ? update(current.document) : update;
      if (document === current.document) return document;
      const next = { ...current, document, modified: Date.now() };
      setSession(next);
      queue.scheduleImmutable(current.id, queue.nextRevision(current.id), {
        document,
        operationId: crypto.randomUUID(),
      });
      return document;
    },
    [queue, setSession],
  );

  const flush = useCallback(async () => {
    await queue.flush(sessionRef.current.id);
  }, [queue]);

  const persistence = useMemo<PersistenceControls>(
    () => ({
      flush: async () => {
        abortRef.current?.abort();
        await workDone.current;
        await flush();
      },
      retry: () => queue.retry(sessionRef.current.id),
    }),
    [flush, queue],
  );

  const adoptDraftResponse = useCallback(
    (saved: PresetCocreatorSession) => {
      const current = sessionRef.current;
      setSession({
        ...saved,
        // Draft endpoints never own the autosaved document. Preserve any optimistic edits.
        document: current.document,
        documentRevision: current.documentRevision,
      });
    },
    [setSession],
  );

  const replaceDraft = useCallback(
    async (preset: Preset, summary = 'Edited preset') => {
      if (busy) return;
      setError(null);
      try {
        const input: ReplacePresetDraftRequest = {
          expectedRevision: sessionRef.current.draftRevision,
          operationId: crypto.randomUUID(),
          summary,
          preset,
        };
        adoptDraftResponse(await presetCocreatorApi.replaceDraft(sessionRef.current.id, input));
      } catch (failure) {
        setError((failure as Error).message);
        throw failure;
      }
    },
    [adoptDraftResponse, busy],
  );

  const restoreDraft = useCallback(
    async (revision: number) => {
      if (busy) return;
      setError(null);
      try {
        adoptDraftResponse(
          await presetCocreatorApi.restoreDraft(sessionRef.current.id, {
            expectedRevision: sessionRef.current.draftRevision,
            operationId: crypto.randomUUID(),
            revision,
          }),
        );
      } catch (failure) {
        setError((failure as Error).message);
      }
    },
    [adoptDraftResponse, busy],
  );

  const undoTurn = useCallback(
    async (turnId: string) => {
      const history = sessionRef.current.history;
      const first = history.findIndex((revision) => revision.turnId === turnId);
      if (first < 0) return;
      await restoreDraft(history[Math.max(0, first - 1)]!.revision);
    },
    [restoreDraft],
  );

  const settings = session.document.settings.assistant;
  const assistantModel = useMemo(
    () => resolveModelRef(connections, settings.model, 'assistant'),
    [connections, settings.model],
  );
  const assistantConnection = assistantModel.ok ? assistantModel.model : null;
  const assistantBlocked = assistantModel.ok ? null : assistantModel.reason;
  const assistantEffort = useMemo(
    () =>
      assistantConnection
        ? coCreatorReasoningEffort(coCreatorReasoningEfforts, 'presetAssistant', {
            connectionId: assistantConnection.id,
            modelId: assistantConnection.model,
          })
        : undefined,
    [coCreatorReasoningEfforts, assistantConnection],
  );
  const countTokens = useTokenizer(assistantConnection?.model ?? '');
  const modelContext = useModelContext(assistantConnection);

  const context = useMemo(() => {
    let measured: ReturnType<typeof buildAssistantRequest> | null = null;
    let blocked = modelSaving ? 'Saving model settings…' : assistantBlocked;
    try {
      if (assistantConnection)
        measured = buildAssistantRequest({
          session,
          messages: session.document.messages,
          model: assistantConnection,
          contextTokens: modelContext.tokens,
          countText: countTokens.countText,
          referenceNames,
          reasoningEffort: assistantEffort,
        });
    } catch (failure) {
      blocked = (failure as Error).message;
    }
    return contextView({
      label: 'Preset Co-Creator',
      model: assistantConnection?.model ?? null,
      total: modelContext.tokens,
      assumed: modelContext.assumed,
      used: measured?.used ?? 0,
      fixed: measured?.fixed ?? 0,
      summary: measured?.summary ?? 0,
      reserved: measured?.budget.reservedTokens ?? 0,
      promptBudget: measured?.budget.promptTokens ?? 0,
      messages: measured?.sources ?? [],
      state: session.document.compaction,
      busy,
      compacting,
      countText: countTokens.countText,
      kind: 'preset',
      blocked,
    });
  }, [
    session,
    assistantConnection,
    assistantEffort,
    modelContext.tokens,
    modelContext.assumed,
    countTokens,
    referenceNames,
    busy,
    compacting,
    modelSaving,
    assistantBlocked,
  ]);

  const setAutoCompaction = useCallback(
    (automatic: boolean) => {
      updateDocument((document) => ({
        ...document,
        compaction: { ...normalizeCompaction(document.compaction), automatic },
      }));
    },
    [updateDocument],
  );

  const performCompaction = useCallback(
    async (
      messages: PresetCocreatorMessage[],
      controller: AbortController,
      contextTokens: number,
      names: readonly string[],
      mode: 'conversation' | 'comparison' = 'conversation',
      effortOverride?: { effort: ReasoningEffort | undefined },
    ) => {
      if (!assistantConnection) return;
      const base = sessionRef.current;
      const reasoningEffort = effortOverride ? effortOverride.effort : assistantEffort;
      const before = buildAssistantRequest({
        session: base,
        messages,
        model: assistantConnection,
        contextTokens,
        countText: countTokens.countText,
        referenceNames: names,
        mode,
        reasoningEffort,
      });
      const plan = makeCompactionPlan({
        messages: before.sources,
        state: base.document.compaction,
        maxPromptTokens: before.budget.promptTokens,
        countText: countTokens.countText,
        kind: 'preset',
      });
      if (!plan || before.fixed > before.budget.promptTokens) return;
      setCompacting(true);
      try {
        let record = {
          ...(await runCompaction({
            plan,
            model: assistantConnection,
            preset: before.preset,
            signal: controller.signal,
            sessionId: base.id,
            feature: 'presetCocreator',
            countText: countTokens.countText,
          })),
          beforeTokens: before.used,
        };
        if (abortRef.current !== controller || sessionRef.current.id !== base.id) return;
        const latest = sessionRef.current;
        const compaction = normalizeCompaction(latest.document.compaction);
        if (record.status === 'complete') {
          const next = {
            ...latest,
            document: {
              ...latest.document,
              compaction: { ...compaction, history: [...compaction.history, record] },
            },
          };
          const after = buildAssistantRequest({
            session: next,
            messages,
            model: assistantConnection,
            contextTokens,
            countText: countTokens.countText,
            referenceNames: names,
            mode,
            reasoningEffort,
          });
          record =
            after.used < before.used && activeCheckpoint(next.document.compaction, after.sources)
              ? { ...record, beforeTokens: before.used, afterTokens: after.used }
              : {
                  ...record,
                  status: 'failed',
                  checkpoint: undefined,
                  error:
                    'The summary did not reduce the current context. The previous context is still in use.',
                };
        }
        updateDocument((document) => ({
          ...document,
          compaction: {
            ...normalizeCompaction(document.compaction),
            history: [...normalizeCompaction(document.compaction).history, record],
          },
        }));
        await flush();
        if (record.status === 'aborted')
          throw new DOMException('Compaction stopped.', 'AbortError');
        if (record.status !== 'complete') throw new Error(record.error ?? 'Compaction failed.');
      } finally {
        setCompacting(false);
      }
    },
    [assistantConnection, assistantEffort, countTokens, updateDocument, flush],
  );

  const compact = useCallback(async () => {
    if (busy || abortRef.current || modelSavingRef.current || !assistantConnection) return;
    const requestEffort = { effort: assistantEffort };
    const controller = new AbortController();
    abortRef.current = controller;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    workDone.current = done;
    setBusy(true);
    setCompacting(true);
    setError(null);
    try {
      await flush();
      const contextTokens = await resolveModelContext(assistantConnection, controller.signal);
      controller.signal.throwIfAborted();
      await performCompaction(
        sessionRef.current.document.messages,
        controller,
        contextTokens,
        referenceNames,
        'conversation',
        requestEffort,
      );
    } catch (failure) {
      if (!controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (workDone.current === done) workDone.current = null;
      setBusy(false);
      setCompacting(false);
      finish();
    }
  }, [busy, assistantConnection, assistantEffort, flush, performCompaction, referenceNames]);

  const commitMessages = useCallback(
    (messages: PresetCocreatorMessage[]) =>
      updateDocument((document) => ({ ...document, messages: [...messages] })),
    [updateDocument],
  );

  const executeAssistantTurn = useCallback(
    async (
      startingMessages: PresetCocreatorMessage[],
      mode: 'conversation' | 'comparison' = 'conversation',
      effortOverride?: { effort: ReasoningEffort | undefined },
    ) => {
      if (abortRef.current) return;
      if (!assistantConnection) {
        setError(assistantBlocked ?? 'Choose an assistant model.');
        return;
      }
      const requestEffort = effortOverride ?? {
        effort: coCreatorReasoningEffort(effortsRef.current, 'presetAssistant', {
          connectionId: assistantConnection.id,
          modelId: assistantConnection.model,
        }),
      };
      const controller = new AbortController();
      abortRef.current = controller;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      workDone.current = done;
      setBusy(true);
      setError(null);
      // The bubble mounts the moment `busy` flips, and the store may still hold the
      // previous turn's last frame — reset it before the first await can show that.
      stream.begin('', true);
      const turnId = crypto.randomUUID();
      let messages = [...startingMessages];
      let partial: StreamState | null = null;
      // The folder can change between turns, so the catalogue is refreshed per turn and
      // the names ride the system prompt — the model reads the full file only on demand.
      let referenceNames: string[] = [];
      try {
        referenceNames = (await referencePresetApi.list(controller.signal)).map(
          (entry) => entry.name,
        );
      } catch {
        // A missing or unreadable folder must not fail the turn — the tool still answers
        // real read attempts with their own errors.
      }

      try {
        for (
          let requestIndex = 0;
          requestIndex < (mode === 'comparison' ? 1 : ASSISTANT_REQUEST_LIMIT);
          requestIndex += 1
        ) {
          controller.signal.throwIfAborted();
          // Land results and refresh committed patch receipts before the next paid request.
          // A failed save stops the loop rather than sending an unverified edit outcome.
          await flush();
          controller.signal.throwIfAborted();
          const contextTokens = await resolveModelContext(assistantConnection, controller.signal);
          controller.signal.throwIfAborted();
          let request = buildAssistantRequest({
            session: sessionRef.current,
            messages,
            model: assistantConnection,
            contextTokens,
            countText: countTokens.countText,
            referenceNames,
            mode,
            reasoningEffort: requestEffort.effort,
          });
          if (
            shouldCompact(
              sessionRef.current.document.compaction,
              request.used,
              request.budget.promptTokens,
            )
          ) {
            await performCompaction(
              messages,
              controller,
              contextTokens,
              referenceNames,
              mode,
              requestEffort,
            );
            controller.signal.throwIfAborted();
            request = buildAssistantRequest({
              session: sessionRef.current,
              messages,
              model: assistantConnection,
              contextTokens,
              countText: countTokens.countText,
              referenceNames,
              mode,
              reasoningEffort: requestEffort.effort,
            });
          }
          const { body, budget, used } = request;
          if (used > budget.promptTokens) {
            throw new Error(
              "The context still exceeds this model's limit. Compact more conversation, reduce the fixed preset or instructions, or choose a larger model.",
            );
          }

          // Every provider request is its own stream: the store resets for it, and again
          // below once the transcript owns the reply.
          stream.begin('', true);
          const generationId = crypto.randomUUID();
          partial = null;
          const final = await runGeneration({
            model: assistantConnection,
            body,
            signal: controller.signal,
            usage: {
              feature: 'presetCocreator',
              generationId,
              sessionId: sessionRef.current.id,
              countText: countTokens.countText,
            },
            onTick: (state) => {
              if (abortRef.current !== controller || controller.signal.aborted) return;
              partial = state;
              stream.set(state.content, state.reasoning);
            },
          });
          partial = final;
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          const assistantMessage: PresetCocreatorMessage = {
            ...assistantResponseMessage(
              final,
              mode === 'comparison' && final.toolCalls?.length ? 'error' : undefined,
              assistantConnection,
            ),
            turnId,
            ...(mode === 'comparison' ? { analysisOnly: true } : {}),
            ...messageUsage(final, assistantConnection),
          };
          partial = null;
          messages = [...messages, assistantMessage];
          commitMessages(messages);
          // The committed message renders the reply in the transcript now; the bubble
          // resets to its quiet working note for the tool call or the next request.
          stream.begin('', true);

          if (mode === 'comparison') rejectComparisonToolCalls(final.toolCalls);
          if (assistantMessage.incomplete) {
            setError(
              assistantMessage.incomplete === 'error'
                ? 'The model returned tool calls without unique ids. They were saved but not run: use Continue to retry.'
                : 'The reply was cut off. What arrived is saved: use Continue to get the rest.',
            );
            await flush();
            return;
          }
          if (!final.toolCalls?.length) {
            await flush();
            return;
          }

          await executePresetToolBatch({
            calls: assistantMessage.toolCalls!,
            turnId,
            signal: controller.signal,
            deps: {
              currentRevision: () => sessionRef.current.current,
              identity: () => presetIdentity(sessionRef.current),
              beforePatch: flush,
              patchDraft: async (input) => {
                try {
                  // Once dispatched, let the atomic mutation settle even after Stop so
                  // its committed receipt is retained. The batch skips subsequent tools.
                  const saved = await presetCocreatorApi.patchDraft(sessionRef.current.id, input);
                  adoptDraftResponse(saved);
                  return (
                    saved.history.find((revision) => revision.operationId === input.operationId) ??
                    saved.current
                  );
                } catch (failure) {
                  if (failure instanceof ApiError && failure.status < 500) throw failure;
                  throw new UnconfirmedPresetPatchError(failure);
                }
              },
              proposeTest: (proposal) =>
                updateDocument((document) => ({
                  ...document,
                  proposedTests: [...document.proposedTests, proposal],
                })),
              readReference: async (name, signal) => {
                const record = await referencePresetApi.get(name, signal);
                return referencePresetView(record.name, record.version, record.preset);
              },
            },
            onResult: (toolMessage) => {
              messages = [...messages, toolMessage];
              commitMessages(messages);
            },
          });
        }
        if (mode === 'conversation') {
          setError(
            `The assistant reached the ${ASSISTANT_REQUEST_LIMIT}-request turn limit. Continue when ready.`,
          );
          await flush();
        }
      } catch (failure) {
        // A Stop or a broken stream still costs tokens. Preserve its latest snapshot.
        if (partial) {
          const received = {
            ...assistantResponseMessage(
              partial,
              controller.signal.aborted ? 'stopped' : 'error',
              assistantConnection,
            ),
            turnId,
            ...messageUsage(partial, assistantConnection),
          };
          if (received.content || received.reasoning || received.incompleteToolCalls?.length) {
            messages = [
              ...messages,
              { ...received, ...(mode === 'comparison' ? { analysisOnly: true } : {}) },
            ];
            commitMessages(messages);
          }
        }
        if ((failure as Error).name !== 'AbortError') setError((failure as Error).message);
        await flush().catch(() => {});
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        // Flushes whatever a throttled frame was still holding and marks the store idle,
        // so the next turn starts from a clean snapshot.
        stream.end();
        setBusy(false);
        if (workDone.current === done) workDone.current = null;
        finish();
      }
    },
    [
      adoptDraftResponse,
      assistantConnection,
      assistantBlocked,
      commitMessages,
      countTokens,
      flush,
      stream,
      updateDocument,
      performCompaction,
    ],
  );

  /** Post the user's side of a turn, then let the Co-Creator answer it. */
  const startTurnWith = useCallback(
    async (
      message: PresetCocreatorMessage,
      mode: 'conversation' | 'comparison' = 'conversation',
      effortOverride?: { effort: ReasoningEffort | undefined },
    ) => {
      const messages = [...sessionRef.current.document.messages, message];
      commitMessages(messages);
      await flush();
      if (mode === 'comparison') setPreparing(false);
      await executeAssistantTurn(messages, mode, effortOverride);
    },
    [commitMessages, executeAssistantTurn, flush],
  );

  const continueReply = useCallback(async () => {
    if (busy || preparing || abortRef.current || modelSavingRef.current) return;
    const requestEffort = { effort: assistantEffort };
    const last = sessionRef.current.document.messages.at(-1);
    if (last?.role !== 'assistant' || !last.incomplete) return;
    const content = last.incompleteToolCalls?.length
      ? `Your previous response was interrupted during a tool call. The incomplete calls were saved but never executed. Continue the task; reissue any unfinished tool call with complete JSON. Saved incomplete arguments (data):\n${JSON.stringify(last.incompleteToolCalls)}`
      : 'Continue your interrupted answer exactly where it stopped. Do not repeat the existing answer.';
    await startTurnWith(
      {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        created: Date.now(),
        appAction: 'continue',
      },
      last.analysisOnly ? 'comparison' : 'conversation',
      requestEffort,
    );
  }, [busy, preparing, assistantEffort, startTurnWith]);

  const send = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || busy || modelSavingRef.current) return;
      const requestEffort = { effort: assistantEffort };
      await startTurnWith(
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: text,
          created: Date.now(),
        },
        'conversation',
        requestEffort,
      );
    },
    [busy, assistantEffort, startTurnWith],
  );

  const compare = useCallback(
    async (source: PresetComparisonSource, label: string, focus: string) => {
      if (busy || preparingComparison.current)
        throw new Error('The Co-Creator is already working.');
      if (modelSavingRef.current) throw new Error('Saving model settings…');
      const requestEffort = { effort: assistantEffort };
      preparingComparison.current = true;
      setPreparing(true);
      setBusy(true);
      setError(null);
      try {
        const before = sessionRef.current;
        const other = await loadComparisonPreset(source, before.history);
        const current = sessionRef.current.current;
        const comparison = {
          draft: {
            label: before.targetPresetId ?? before.title,
            revision: current.revision,
            preset: structuredClone(current.preset),
          },
          other: { label, source: structuredClone(source), preset: structuredClone(other) },
          focus: focus.trim(),
        };
        const message: PresetCocreatorMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          content: comparison.focus,
          comparison,
          created: Date.now(),
        };
        await startTurnWith(message, 'comparison', requestEffort);
      } catch (failure) {
        setError((failure as Error).message);
        throw failure;
      } finally {
        preparingComparison.current = false;
        setPreparing(false);
        setBusy(false);
      }
    },
    [busy, assistantEffort, startTurnWith],
  );

  /**
   * A shared test report is a whole user turn, not an attachment waiting for one: it posts
   * and the Co-Creator answers it straight away. Posting it silently left the user typing
   * "here" just to start the reply.
   */
  const sendReport = useCallback(
    async (report: PresetTestReport) => {
      if (busy || modelSavingRef.current) return;
      const requestEffort = { effort: assistantEffort };
      await startTurnWith(reportConversationMessage(report), 'conversation', requestEffort);
    },
    [busy, assistantEffort, startTurnWith],
  );

  /** Move the saved queue into one conversation turn before contacting the provider. */
  const sendBatch = useCallback(async () => {
    if (busy || preparingBatch.current) throw new Error('The Co-Creator is already working.');
    if (modelSavingRef.current) throw new Error('Saving model settings…');
    const requestEffort = { effort: assistantEffort };
    const previousQueue = structuredClone(sessionRef.current.document.batchQueue);
    const batch = buildPresetTestBatch(previousQueue);
    const message = batchConversationMessage(batch);
    preparingBatch.current = true;
    setBatchSending(true);
    setError(null);
    const messages = [...sessionRef.current.document.messages, message];
    updateDocument((document) => ({
      ...document,
      messages,
      batchQueue: { ...document.batchQueue, items: [], note: '' },
    }));
    try {
      try {
        await flush();
      } catch (failure) {
        updateDocument((document) => ({
          ...document,
          messages: document.messages.filter((entry) => entry.id !== message.id),
          batchQueue: previousQueue,
        }));
        throw failure;
      }
      void executeAssistantTurn(messages, 'conversation', requestEffort);
      return batch;
    } catch (failure) {
      setError((failure as Error).message);
      throw failure;
    } finally {
      preparingBatch.current = false;
      setBatchSending(false);
    }
  }, [busy, assistantEffort, executeAssistantTurn, flush, updateDocument]);

  const editMessage = useCallback(
    (id: string, text: string) => {
      if (busy) return;
      updateDocument((document) => ({
        ...document,
        messages: editAssistantConversationMessage(document.messages, id, text),
      }));
    },
    [busy, updateDocument],
  );

  const publish = useCallback(
    async (input: Omit<PublishPresetDraftRequest, 'operationId' | 'revision'>) => {
      await flush();
      const current = sessionRef.current;
      const result = await presetCocreatorApi.publish(current.id, {
        ...input,
        revision: current.draftRevision,
        operationId: crypto.randomUUID(),
      });
      setSession({
        ...current,
        targetPresetId: result.presetId,
        targetPresetVersion: result.version,
      });
      return result;
    },
    [flush, setSession],
  );

  const rename = useCallback(
    async (title: string) => {
      await flush();
      const saved = await presetCocreatorApi.rename(sessionRef.current.id, { title });
      const current = sessionRef.current;
      setSession({
        ...saved,
        document: current.document,
        documentRevision: current.documentRevision,
      });
    },
    [flush, setSession],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  useEffect(() => () => abortRef.current?.abort(), []);

  /*
   * One identity for the whole controller, changing only when its contents change. The
   * workspace re-renders for its own reasons — split drags, tab switches, the title
   * field — and the panels below are memoised on this object, so those re-renders must
   * not hand them a fresh identity and defeat the memo.
   */
  return useMemo(
    () => ({
      session,
      saving,
      busy,
      preparing,
      compacting,
      context,
      compact,
      setAutoCompaction,
      batchSending,
      error,
      setError,
      stream,
      assistantConnection,
      assistantBlocked,
      assistantEffort,
      updateDocument,
      replaceDraft,
      restoreDraft,
      undoTurn,
      send,
      continueReply,
      compare,
      sendReport,
      sendBatch,
      editMessage,
      stop,
      publish,
      rename,
      flush,
      persistence,
    }),
    [
      session,
      saving,
      busy,
      preparing,
      compacting,
      context,
      compact,
      setAutoCompaction,
      batchSending,
      error,
      stream,
      assistantConnection,
      assistantBlocked,
      assistantEffort,
      updateDocument,
      replaceDraft,
      restoreDraft,
      undoTurn,
      send,
      continueReply,
      compare,
      sendReport,
      sendBatch,
      editMessage,
      stop,
      publish,
      rename,
      flush,
      persistence,
    ],
  );
}

export type PresetCocreatorController = ReturnType<typeof usePresetCocreator>;
