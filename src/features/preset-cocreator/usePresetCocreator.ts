import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
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
import { presetCocreatorApi, referencePresetApi, streamGenerate } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import { createStreamStore } from '../chat/state/streamStore.ts';
import {
  ASSISTANT_REQUEST_LIMIT,
  assistantWireMessages,
  configureAssistantMode,
  editAssistantConversationMessage,
  executePresetToolCall,
  presetIdentity,
  referencePresetView,
  rejectComparisonToolCalls,
  renderAssistantSystem,
  toolFailureResult,
} from './assistant.ts';
import { loadComparisonPreset } from './compareSources.ts';
import {
  batchConversationMessage,
  buildPresetTestBatch,
  reportConversationMessage,
} from './testing.ts';

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
  const assistantConnection = useMemo(() => {
    const connection = connections.find((entry) => entry.id === settings.connectionId) ?? null;
    if (!connection) return null;
    return { ...connection, model: settings.model.trim() || connection.model };
  }, [connections, settings.connectionId, settings.model]);
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
      if (!assistantConnection) {
        setError('Choose an assistant connection and model.');
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
      // The folder can change between turns, so the catalogue is refreshed per turn and
      // the names ride the system prompt — the model reads the full file only on demand.
      let referenceNames: string[] = [];
      try {
        referenceNames = (await referencePresetApi.list()).map((entry) => entry.name);
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
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const current = sessionRef.current;
          const generation = current.document.settings.assistant;
          const utilityPreset = createDefaultPreset();
          utilityPreset.temperature = generation.temperature;
          utilityPreset.openai_max_tokens = generation.maxTokens;
          utilityPreset.reasoning_effort = generation.reasoningEffort;
          utilityPreset.stream_openai = true;

          const body = buildRequestBody({
            messages: [],
            preset: utilityPreset,
            connection: assistantConnection,
            stream: true,
            maxTokens: generation.maxTokens,
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
            ...assistantWireMessages(messages),
          ];
          configureAssistantMode(body, mode);

          // Every provider request is its own stream: the store resets for it, and again
          // below once the transcript owns the reply.
          stream.begin('', true);
          const generationId = crypto.randomUUID();
          const final = await streamGenerate(
            body,
            controller.signal,
            {
              onTick: (state) => {
                if (abortRef.current !== controller) return;
                stream.set(state.content, state.reasoning);
              },
            },
            '',
            assistantConnection.id,
            {
              feature: 'presetCocreator',
              generationId,
              sessionId: current.id,
              countText: countTokens.countText,
            },
          );
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          const assistantMessage: PresetCocreatorMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: final.content,
            created: Date.now(),
            ...(final.reasoning ? { reasoning: final.reasoning } : {}),
            ...(final.reasoningDetails?.length ? { reasoningDetails: final.reasoningDetails } : {}),
            ...(final.toolCalls?.length ? { toolCalls: final.toolCalls } : {}),
          };
          if (mode === 'comparison') rejectComparisonToolCalls(final.toolCalls);
          messages = [...messages, assistantMessage];
          commitMessages(messages);
          // The committed message renders the reply in the transcript now; the bubble
          // resets to its quiet working note for the tool call or the next request.
          stream.begin('', true);

          if (!final.toolCalls?.length) {
            await flush();
            return;
          }

          for (const call of final.toolCalls) {
            // Without an id no tool message can answer this call, and most providers reject
            // a follow-up request whose tool_calls were left unanswered — turn-fatal.
            if (!call.id) throw new Error('The model returned a tool call without an id.');
            let result: unknown;
            try {
              result = await executePresetToolCall(call, turnId, {
                currentRevision: () => sessionRef.current.current,
                identity: () => presetIdentity(sessionRef.current),
                patchDraft: async (input) => {
                  await flush();
                  const saved = await presetCocreatorApi.patchDraft(sessionRef.current.id, input);
                  adoptDraftResponse(saved);
                  return saved.current;
                },
                proposeTest: (proposal) =>
                  updateDocument((document) => ({
                    ...document,
                    proposedTests: [...document.proposedTests, proposal],
                  })),
                readReference: async (name) => {
                  const record = await referencePresetApi.get(name);
                  return referencePresetView(record.name, record.version, record.preset);
                },
              });
            } catch (failure) {
              // A rejected tool call is data for the model, not the end of the turn: it
              // reads the error and sends a corrected call within the same request budget.
              result = toolFailureResult(failure);
            }
            const toolMessage: PresetCocreatorMessage = {
              id: crypto.randomUUID(),
              role: 'tool',
              content: JSON.stringify(result),
              created: Date.now(),
              toolCallId: call.id,
              toolName: call.function.name,
            };
            messages = [...messages, toolMessage];
            commitMessages(messages);
          }
        }
        if (mode === 'conversation') {
          setError(
            `The assistant reached the ${ASSISTANT_REQUEST_LIMIT}-request turn limit. Continue when ready.`,
          );
          await flush();
        }
      } catch (failure) {
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
      commitMessages,
      countTokens.countText,
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
