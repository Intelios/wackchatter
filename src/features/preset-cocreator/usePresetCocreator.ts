import { cocreatorBudget } from '@shared/cocreator/generation.ts';
import { resolveModelRef } from '@shared/models/slots.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { StreamState } from '@shared/providers/sse.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { Preset } from '@shared/types/preset.ts';
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
import { resolveModelContext } from '../models/modelContext.ts';
import {
  ASSISTANT_REQUEST_LIMIT,
  assistantResponseMessage,
  assistantWireMessages,
  configureAssistantMode,
  editAssistantConversationMessage,
  presetIdentity,
  referencePresetView,
  rejectComparisonToolCalls,
  renderAssistantSystem,
  UnconfirmedPresetPatchError,
} from './assistant.ts';
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
  streamingFps: number;
}

export function usePresetCocreator({
  initial,
  connections,
  streamingFps,
}: UsePresetCocreatorOptions) {
  const [session, setSessionState] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [batchSending, setBatchSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef(session);
  const serverDocumentRevision = useRef(new Map<string, number>());
  const abortRef = useRef<AbortController | null>(null);
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
    () => ({ flush, retry: () => queue.retry(sessionRef.current.id) }),
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
  const countTokens = useTokenizer(assistantConnection?.model ?? '');

  const commitMessages = useCallback(
    (messages: PresetCocreatorMessage[]) =>
      updateDocument((document) => ({ ...document, messages: [...messages] })),
    [updateDocument],
  );

  const executeAssistantTurn = useCallback(
    async (
      startingMessages: PresetCocreatorMessage[],
      mode: 'conversation' | 'comparison' = 'conversation',
    ) => {
      if (abortRef.current) return;
      if (!assistantConnection) {
        setError(assistantBlocked ?? 'Choose an assistant model.');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
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
          const current = sessionRef.current;
          const generation = current.document.settings.assistant;
          const utilityPreset = createDefaultPreset();
          utilityPreset.temperature = generation.temperature;
          utilityPreset.openai_max_tokens = generation.maxTokens;
          utilityPreset.reasoning_effort = generation.reasoningEffort;
          utilityPreset.stream_openai = true;

          // Sized from the model's own context, like every other Co-Creator request.
          const budget = cocreatorBudget({
            preset: utilityPreset,
            connection: assistantConnection,
            outputTokens: generation.maxTokens,
            contextTokens: await resolveModelContext(assistantConnection),
          });
          controller.signal.throwIfAborted();
          const body = buildRequestBody({
            messages: [],
            preset: utilityPreset,
            connection: assistantConnection,
            stream: true,
            // No cap: the budget only reserves room in the context.
            maxTokens: null,
          });
          body.messages = [
            {
              role: 'system',
              content: renderAssistantSystem(
                current.current,
                current.document.settings.assistantInstructions,
                referenceNames,
                presetIdentity(current),
              ),
            },
            ...assistantWireMessages(messages, current.history),
          ];
          configureAssistantMode(body, mode);
          // Tool JSON and reasoning details also consume input; include them in the estimate.
          const inputTokens =
            countTokens.countText(JSON.stringify(body.messages)) +
            (body.tools ? countTokens.countText(JSON.stringify(body.tools)) : 0);
          if (inputTokens > budget.promptTokens) {
            throw new Error(
              "The conversation is longer than this model's context. Start a new session, or pick a model with a longer context.",
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
              sessionId: current.id,
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
            ...assistantResponseMessage(partial, controller.signal.aborted ? 'stopped' : 'error'),
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
    ],
  );

  /** Post the user's side of a turn, then let the Co-Creator answer it. */
  const startTurnWith = useCallback(
    async (
      message: PresetCocreatorMessage,
      mode: 'conversation' | 'comparison' = 'conversation',
    ) => {
      const messages = [...sessionRef.current.document.messages, message];
      commitMessages(messages);
      await flush();
      if (mode === 'comparison') setPreparing(false);
      await executeAssistantTurn(messages, mode);
    },
    [commitMessages, executeAssistantTurn, flush],
  );

  const continueReply = useCallback(async () => {
    if (busy || preparing || abortRef.current) return;
    const last = sessionRef.current.document.messages.at(-1);
    if (last?.role !== 'assistant' || !last.incomplete) return;
    const content = last.incompleteToolCalls?.length
      ? `Your previous response was interrupted during a tool call. The incomplete calls were saved but never executed. Continue the task; reissue any unfinished tool call with complete JSON. Saved incomplete arguments (data):\n${JSON.stringify(last.incompleteToolCalls)}`
      : 'Continue your interrupted answer exactly where it stopped. Do not repeat the existing answer.';
    await startTurnWith(
      { id: crypto.randomUUID(), role: 'user', content, created: Date.now() },
      last.analysisOnly ? 'comparison' : 'conversation',
    );
  }, [busy, preparing, startTurnWith]);

  const send = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || busy) return;
      await startTurnWith({
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        created: Date.now(),
      });
    },
    [busy, startTurnWith],
  );

  const compare = useCallback(
    async (source: PresetComparisonSource, label: string, focus: string) => {
      if (busy || preparingComparison.current)
        throw new Error('The Co-Creator is already working.');
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
        await startTurnWith(message, 'comparison');
      } catch (failure) {
        setError((failure as Error).message);
        throw failure;
      } finally {
        preparingComparison.current = false;
        setPreparing(false);
        setBusy(false);
      }
    },
    [busy, startTurnWith],
  );

  /**
   * A shared test report is a whole user turn, not an attachment waiting for one: it posts
   * and the Co-Creator answers it straight away. Posting it silently left the user typing
   * "here" just to start the reply.
   */
  const sendReport = useCallback(
    async (report: PresetTestReport) => {
      if (busy) return;
      await startTurnWith(reportConversationMessage(report));
    },
    [busy, startTurnWith],
  );

  /** Move the saved queue into one conversation turn before contacting the provider. */
  const sendBatch = useCallback(async () => {
    if (busy || preparingBatch.current) throw new Error('The Co-Creator is already working.');
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
      void executeAssistantTurn(messages);
      return batch;
    } catch (failure) {
      setError((failure as Error).message);
      throw failure;
    } finally {
      preparingBatch.current = false;
      setBatchSending(false);
    }
  }, [busy, executeAssistantTurn, flush, updateDocument]);

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
      batchSending,
      error,
      setError,
      stream,
      assistantConnection,
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
      batchSending,
      error,
      stream,
      assistantConnection,
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
