import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { Preset } from '@shared/types/preset.ts';
import type {
  PresetCocreatorDocument,
  PresetCocreatorMessage,
  PresetCocreatorSession,
  PublishPresetDraftRequest,
  ReplacePresetDraftRequest,
} from '@shared/types/preset-cocreator.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { presetCocreatorApi, streamGenerate } from '../../lib/api.ts';
import { AutosaveQueue, type PersistenceControls } from '../../lib/autosave.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import {
  ASSISTANT_REQUEST_LIMIT,
  assistantWireMessages,
  executePresetToolCall,
  PRESET_ASSISTANT_TOOLS,
  renderAssistantSystem,
  toolFailureResult,
} from './assistant.ts';

interface DocumentSnapshot {
  document: PresetCocreatorDocument;
  operationId: string;
}

export interface UsePresetCocreatorOptions {
  initial: PresetCocreatorSession;
  connections: readonly Connection[];
  streamingFps: number;
}

export function usePresetCocreator({ initial, connections }: UsePresetCocreatorOptions) {
  const [session, setSessionState] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const sessionRef = useRef(session);
  const serverDocumentRevision = useRef(new Map<string, number>());
  const abortRef = useRef<AbortController | null>(null);

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

  const updateDocument = useCallback(
    (
      update:
        | PresetCocreatorDocument
        | ((current: PresetCocreatorDocument) => PresetCocreatorDocument),
    ): PresetCocreatorDocument => {
      const current = sessionRef.current;
      const document =
        typeof update === 'function' ? update(structuredClone(current.document)) : update;
      const next = { ...current, document, modified: Date.now() };
      setSession(next);
      queue.schedule(current.id, queue.nextRevision(current.id), {
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
      updateDocument((document) => ({ ...document, messages: structuredClone(messages) })),
    [updateDocument],
  );

  const executeAssistantTurn = useCallback(
    async (startingMessages: PresetCocreatorMessage[]) => {
      if (!assistantConnection) {
        setError('Choose an assistant connection and model.');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setError(null);
      const turnId = crypto.randomUUID();
      let messages = [...startingMessages];

      try {
        for (let requestIndex = 0; requestIndex < ASSISTANT_REQUEST_LIMIT; requestIndex += 1) {
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
              ),
            },
            ...assistantWireMessages(messages),
          ];
          body.tools = PRESET_ASSISTANT_TOOLS;
          body.tool_choice = 'auto';

          setStreamingText('');
          setStreamingReasoning('');
          const generationId = crypto.randomUUID();
          const final = await streamGenerate(
            body,
            controller.signal,
            {
              onTick: (state) => {
                if (abortRef.current !== controller) return;
                setStreamingText(state.content);
                setStreamingReasoning(state.reasoning);
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
          messages = [...messages, assistantMessage];
          commitMessages(messages);
          setStreamingText('');
          setStreamingReasoning('');

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
        setError(
          `The assistant reached the ${ASSISTANT_REQUEST_LIMIT}-request turn limit. Continue when ready.`,
        );
        await flush();
      } catch (failure) {
        if ((failure as Error).name !== 'AbortError') setError((failure as Error).message);
        await flush().catch(() => {});
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setStreamingText('');
        setStreamingReasoning('');
        setBusy(false);
      }
    },
    [
      adoptDraftResponse,
      assistantConnection,
      commitMessages,
      countTokens.countText,
      flush,
      updateDocument,
    ],
  );

  const send = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || busy) return;
      const message: PresetCocreatorMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        created: Date.now(),
      };
      const messages = [...sessionRef.current.document.messages, message];
      commitMessages(messages);
      await flush();
      await executeAssistantTurn(messages);
    },
    [busy, commitMessages, executeAssistantTurn, flush],
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

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    session,
    saving,
    busy,
    error,
    setError,
    streamingText,
    streamingReasoning,
    assistantConnection,
    updateDocument,
    replaceDraft,
    restoreDraft,
    undoTurn,
    send,
    stop: () => abortRef.current?.abort(),
    publish,
    rename,
    flush,
    persistence,
  };
}

export type PresetCocreatorController = ReturnType<typeof usePresetCocreator>;
