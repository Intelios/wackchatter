import type { Connection } from '@shared/providers/types.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import type {
  PresetCocreatorModelSettings,
  PresetTest,
  PresetTestEvidence,
  PresetTestReport,
  PresetTestScenario,
  PresetTestSource,
  ProposedPresetTest,
} from '@shared/types/preset-cocreator.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { presetApi, referencePresetApi, streamGenerate } from '../../lib/api.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import {
  appendPresetTestUserMessage,
  buildPresetTestReport,
  createPresetTest,
  dismissPendingProposals,
  editPresetTestMessage,
  enqueuePresetTestReport,
  evidenceForSelectedResponse,
  type PresetTestGenerationKind,
  preparePresetTestRequest,
  restartPresetTest,
  selectPresetTestSwipe,
  settlePresetTestGeneration,
  updateProposedTest,
} from './testing.ts';
import { resolvePresetTestSource } from './testingSources.ts';
import type { PresetCocreatorController } from './usePresetCocreator.ts';

interface UsePresetTestingOptions {
  controller: PresetCocreatorController;
  connections: readonly Connection[];
  tokenizerEncoding?: string;
}

function latestAssistant(messages: readonly ChatMessage[]): ChatMessage | null {
  return [...messages].reverse().find((message) => !message.is_user) ?? null;
}

export function usePresetTesting({
  controller,
  connections,
  tokenizerEncoding,
}: UsePresetTestingOptions) {
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [inspectedEvidenceId, setInspectedEvidenceId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const preparingRef = useRef(false);
  const sessionRef = useRef(controller.session);
  sessionRef.current = controller.session;

  const activeTest = useMemo(
    () =>
      controller.session.document.tests.find(
        (test) => test.id === controller.session.document.activeTestId,
      ) ?? null,
    [controller.session.document.activeTestId, controller.session.document.tests],
  );
  const setting = activeTest?.testingSettings ?? controller.session.document.settings.testing;
  const connection = useMemo(() => {
    const selected = connections.find((entry) => entry.id === setting.connectionId) ?? null;
    return selected ? { ...selected, model: setting.model.trim() || selected.model } : null;
  }, [connections, setting.connectionId, setting.model]);
  const countTokens = useTokenizer(connection?.model ?? '', tokenizerEncoding);

  const saveTest = useCallback(
    (test: PresetTest, makeActive = true) => {
      controller.updateDocument((document) => {
        const exists = document.tests.some((entry) => entry.id === test.id);
        return {
          ...document,
          tests: exists
            ? document.tests.map((entry) => (entry.id === test.id ? structuredClone(test) : entry))
            : [...document.tests, structuredClone(test)],
          activeTestId: makeActive ? test.id : document.activeTestId,
        };
      });
      return test;
    },
    [controller],
  );

  const start = useCallback(
    (scenario: PresetTestScenario, title?: string) => {
      if (busy || preparingRef.current) return null;
      const document = sessionRef.current.document;
      const parent = document.tests.find((test) => test.id === document.activeTestId);
      return saveTest(
        createPresetTest(scenario, title, {
          presetSource: parent?.presetSource ?? { kind: 'draft' },
          testingSettings: parent?.testingSettings ?? document.settings.testing,
        }),
      );
    },
    [busy, saveTest],
  );

  const restart = useCallback(
    (test = activeTest) =>
      test && !busy && !preparingRef.current ? saveTest(restartPresetTest(test)) : null,
    [activeTest, busy, saveTest],
  );

  const setActive = useCallback(
    (id: string) => {
      if (busy || preparingRef.current) return;
      controller.updateDocument((document) =>
        document.tests.some((test) => test.id === id)
          ? { ...document, activeTestId: id }
          : document,
      );
      setInspectedEvidenceId(null);
    },
    [busy, controller],
  );

  const updateActiveTest = useCallback(
    (update: (test: PresetTest) => PresetTest) => {
      if (busy || preparingRef.current) return;
      controller.updateDocument((document) => ({
        ...document,
        tests: document.tests.map((test) =>
          test.id === document.activeTestId ? update(test) : test,
        ),
      }));
    },
    [busy, controller],
  );

  const setPresetSource = useCallback(
    (source: PresetTestSource) =>
      updateActiveTest((test) => ({ ...test, presetSource: structuredClone(source) })),
    [updateActiveTest],
  );
  const setTestingSettings = useCallback(
    (settings: PresetCocreatorModelSettings) => {
      if (activeTest) updateActiveTest((test) => ({ ...test, testingSettings: settings }));
      else
        controller.updateDocument((document) => ({
          ...document,
          settings: { ...document.settings, testing: settings },
        }));
    },
    [activeTest, controller, updateActiveTest],
  );
  const setComposerDraft = useCallback(
    (value: string) => updateActiveTest((test) => ({ ...test, composerDraft: value })),
    [updateActiveTest],
  );

  const generate = useCallback(
    async (
      kind: PresetTestGenerationKind,
      originalTest: PresetTest,
      options: { userText?: string; proposalId?: string } = {},
    ) => {
      if (busy || preparingRef.current) return;
      preparingRef.current = true;
      const controllerAbort = new AbortController();
      abortRef.current = controllerAbort;
      setBusy(true);
      setError(null);
      setStreamingText('');
      setStreamingReasoning('');
      const finish = () => {
        if (abortRef.current === controllerAbort) abortRef.current = null;
        preparingRef.current = false;
        setBusy(false);
        setStreamingText('');
        setStreamingReasoning('');
      };

      const selectedConnection = connections.find(
        (entry) => entry.id === originalTest.testingSettings.connectionId,
      );
      const model = originalTest.testingSettings.model.trim() || selectedConnection?.model || '';
      if (!selectedConnection || !model) {
        setError('Choose a testing connection and model for this chat.');
        finish();
        return;
      }
      const requestConnection = { ...selectedConnection, model };
      const dispatchSession = sessionRef.current;
      let resolved: Awaited<ReturnType<typeof resolvePresetTestSource>>;
      try {
        resolved = await resolvePresetTestSource(originalTest.presetSource, dispatchSession, {
          library: presetApi.getVersioned,
          reference: async (id) => referencePresetApi.get(id),
        });
      } catch (failure) {
        setError((failure as Error).message);
        finish();
        return;
      }
      if (controllerAbort.signal.aborted) {
        finish();
        return;
      }
      let withUser: PresetTest | null;
      try {
        withUser =
          options.userText === undefined
            ? originalTest
            : appendPresetTestUserMessage(originalTest, options.userText, resolved.preset);
      } catch (failure) {
        setError((failure as Error).message);
        finish();
        return;
      }
      if (!withUser) {
        finish();
        return;
      }
      const baseTest =
        options.userText === undefined ? withUser : { ...withUser, composerDraft: '' };
      let prepared: ReturnType<typeof preparePresetTestRequest>;
      try {
        prepared = preparePresetTestRequest({
          test: structuredClone(baseTest),
          kind,
          preset: resolved.preset,
          connection: requestConnection,
          countTokens,
        });
      } catch (failure) {
        setError((failure as Error).message);
        finish();
        return;
      }
      if (!prepared) {
        setError('There is no assistant response to regenerate or swipe.');
        finish();
        return;
      }
      if (options.proposalId) {
        controller.updateDocument((document) => ({
          ...document,
          tests: document.tests.some((entry) => entry.id === baseTest.id)
            ? document.tests.map((entry) => (entry.id === baseTest.id ? baseTest : entry))
            : [...document.tests, baseTest],
          activeTestId: baseTest.id,
          proposedTests: updateProposedTest(document.proposedTests, options.proposalId!, 'run'),
        }));
      } else if (options.userText !== undefined) {
        saveTest(baseTest);
      }

      const generationId = crypto.randomUUID();
      const baseEvidence = (options: {
        id?: string;
        text: string;
        reasoning?: string;
        status: PresetTestEvidence['status'];
        swipeIndex: number;
        error?: string;
        finishReason?: string | null;
        promptTokens?: number;
        completionTokens?: number;
      }): PresetTestEvidence => ({
        id: options.id ?? crypto.randomUUID(),
        created: Date.now(),
        messageId: prepared.target.id,
        swipeIndex: options.swipeIndex,
        draftRevision: dispatchSession.current.revision,
        presetUsed: structuredClone(resolved.used),
        connectionId: requestConnection.id,
        model: requestConnection.model,
        generationId,
        kind,
        status: options.status,
        responseText: options.text,
        ...(options.reasoning ? { responseReasoning: options.reasoning } : {}),
        ...(prepared.replacedResponse !== undefined
          ? { replacedResponse: prepared.replacedResponse }
          : {}),
        messages: structuredClone(prepared.assembled.messages),
        body: prepared.body ? structuredClone(prepared.body) : null,
        tokenCounts: { ...prepared.assembled.tokenCounts },
        totalTokens: prepared.assembled.totalTokens,
        droppedMessages: prepared.assembled.droppedMessages,
        macroWarnings: structuredClone(prepared.assembled.macroWarnings),
        ...(prepared.worldInfo ? { worldInfo: structuredClone(prepared.worldInfo) } : {}),
        ...(options.finishReason !== undefined ? { finishReason: options.finishReason } : {}),
        ...(options.promptTokens !== undefined ? { promptTokens: options.promptTokens } : {}),
        ...(options.completionTokens !== undefined
          ? { completionTokens: options.completionTokens }
          : {}),
        ...(options.error ? { error: options.error } : {}),
      });

      if (!prepared.assembled.ok || !prepared.body) {
        const overflow = prepared.assembled.ok
          ? 'The request could not be built.'
          : `Context overflow by ${prepared.assembled.error.overBy} tokens.`;
        const evidence = baseEvidence({
          text: '',
          status: 'failed',
          swipeIndex: prepared.target.swipe_id ?? 0,
          error: overflow,
        });
        saveTest({ ...baseTest, modified: Date.now(), evidence: [...baseTest.evidence, evidence] });
        setInspectedEvidenceId(evidence.id);
        setError(overflow);
        finish();
        return;
      }

      let text = '';
      let reasoning = '';
      try {
        const final = await streamGenerate(
          prepared.body,
          controllerAbort.signal,
          {
            onTick: (state) => {
              if (abortRef.current !== controllerAbort) return;
              text = state.content;
              reasoning = state.reasoning;
              setStreamingText(text);
              setStreamingReasoning(reasoning);
            },
          },
          '',
          requestConnection.id,
          {
            feature: 'presetTest',
            generationId,
            sessionId: sessionRef.current.id,
            character: baseTest.scenario.characterId ?? undefined,
            countText: countTokens.countText,
          },
        );
        text = final.content;
        reasoning = final.reasoning;
        const selectedIndex = prepared.target.swipe_id ?? 0;
        const mainEvidence = baseEvidence({
          text,
          reasoning,
          status: 'complete',
          swipeIndex: selectedIndex,
          finishReason: final.finishReason,
          promptTokens: final.usage?.prompt_tokens,
          completionTokens: final.usage?.completion_tokens,
        });
        const alternates = (final.alternates ?? [])
          .filter((alternate) => alternate.content.trim())
          .map((alternate, index) => {
            const evidence = baseEvidence({
              text: alternate.content,
              reasoning: alternate.reasoning,
              status: 'complete',
              swipeIndex: selectedIndex + index + 1,
              finishReason: alternate.finishReason,
            });
            return {
              text: alternate.content,
              evidence,
              info: {
                send_date: new Date().toISOString(),
                extra: {
                  model: final.model ?? requestConnection.model,
                  connection_id: requestConnection.id,
                  generation_id: generationId,
                  ...(alternate.reasoning ? { reasoning: alternate.reasoning } : {}),
                },
              },
            };
          });
        const settled = settlePresetTestGeneration({
          test: baseTest,
          prepared,
          evidence: [mainEvidence, ...alternates.map((alternate) => alternate.evidence)],
          text,
          reasoning,
          alternates,
        });
        saveTest(settled);
        setInspectedEvidenceId(mainEvidence.id);
      } catch (failure) {
        const aborted = controllerAbort.signal.aborted;
        const message = aborted ? 'Generation stopped.' : (failure as Error).message;
        const evidence = baseEvidence({
          text,
          reasoning,
          status: aborted ? 'aborted' : 'failed',
          swipeIndex: prepared.target.swipe_id ?? 0,
          error: message,
        });
        const settled = text
          ? settlePresetTestGeneration({
              test: baseTest,
              prepared,
              evidence: [evidence],
              text,
              reasoning,
            })
          : {
              ...baseTest,
              modified: Date.now(),
              evidence: [...baseTest.evidence, evidence],
              localVariables: prepared.assembled.variableUpdates.local,
              globalVariables: prepared.assembled.variableUpdates.global,
            };
        saveTest(settled);
        setInspectedEvidenceId(evidence.id);
        if (!aborted) setError(message);
      } finally {
        finish();
      }
    },
    [busy, connections, controller, countTokens, saveTest],
  );

  const send = useCallback(
    async (text: string, test = activeTest) => {
      if (!test || busy) return;
      await generate('send', test, { userText: text });
    },
    [activeTest, busy, generate],
  );

  const regenerate = useCallback(async () => {
    if (activeTest) await generate('regenerate', activeTest);
  }, [activeTest, generate]);

  const swipe = useCallback(
    async (direction: -1 | 1) => {
      if (!activeTest || busy) return;
      const message = latestAssistant(activeTest.messages);
      if (!message) return;
      const current = message.swipe_id ?? 0;
      const count = message.swipes?.length ?? 1;
      const next = current + direction;
      if (next >= 0 && next < count) {
        saveTest(selectPresetTestSwipe(activeTest, message.id, next));
      } else if (direction === 1) {
        await generate('swipe', activeTest);
      }
    },
    [activeTest, busy, generate, saveTest],
  );

  const editMessage = useCallback(
    (id: string, text: string) => {
      if (activeTest && !busy) saveTest(editPresetTestMessage(activeTest, id, text));
    },
    [activeTest, busy, saveTest],
  );

  const dismissProposal = useCallback(
    (id: string) =>
      controller.updateDocument((document) => ({
        ...document,
        proposedTests: updateProposedTest(document.proposedTests, id, 'dismissed'),
      })),
    [controller],
  );

  const dismissAllProposals = useCallback(
    () =>
      controller.updateDocument((document) => ({
        ...document,
        proposedTests: dismissPendingProposals(document.proposedTests),
      })),
    [controller],
  );

  const runProposal = useCallback(
    async (proposal: ProposedPresetTest, editedMessage: string) => {
      if (!activeTest || busy) {
        setError('Create a test scenario before running an assistant proposal.');
        return;
      }
      const target = proposal.restart ? restartPresetTest(activeTest) : activeTest;
      await generate('send', target, { userText: editedMessage, proposalId: proposal.id });
    },
    [activeTest, busy, generate],
  );

  const queueReply = useCallback(
    (messageId: string, testId = activeTest?.id) => {
      const test = sessionRef.current.document.tests.find((entry) => entry.id === testId);
      const message = test?.messages.find((entry) => entry.id === messageId);
      if (!test || !message || message.is_user || !evidenceForSelectedResponse(test, message))
        return false;
      const report = buildPresetTestReport({
        test,
        throughMessageId: messageId,
        note: '',
        includeTranscript: true,
        includePrompt: true,
        includeDiagnostics: true,
      });
      controller.updateDocument((document) => ({
        ...document,
        batchQueue: enqueuePresetTestReport(document.batchQueue, report),
      }));
      return true;
    },
    [activeTest?.id, controller],
  );

  const updateBatch = useCallback(
    (
      update: (
        queue: typeof controller.session.document.batchQueue,
      ) => typeof controller.session.document.batchQueue,
    ) =>
      controller.updateDocument((document) => ({
        ...document,
        batchQueue: update(document.batchQueue),
      })),
    [controller],
  );

  const removeBatchItem = useCallback(
    (id: string) =>
      updateBatch((queue) => ({
        ...queue,
        items: queue.items.filter((item) => item.id !== id),
      })),
    [updateBatch],
  );

  const setBatchItemNote = useCallback(
    (id: string, note: string) =>
      updateBatch((queue) => ({
        ...queue,
        items: queue.items.map((item) => (item.id === id ? { ...item, note } : item)),
      })),
    [updateBatch],
  );

  const share = useCallback(
    (options: {
      throughMessageId: string;
      note: string;
      includeTranscript: boolean;
      includePrompt: boolean;
      includeDiagnostics: boolean;
    }): PresetTestReport | null => {
      if (!activeTest || controller.busy) return null;
      const report = buildPresetTestReport({ test: activeTest, ...options });
      // Sending is the turn: the Co-Creator starts answering on the left immediately.
      void controller.sendReport(report);
      return report;
    },
    [activeTest, controller],
  );

  const inspectedEvidence = useMemo(() => {
    if (!activeTest) return null;
    if (inspectedEvidenceId) {
      const evidence = activeTest.evidence.find((entry) => entry.id === inspectedEvidenceId);
      if (evidence) return evidence;
    }
    const message = latestAssistant(activeTest.messages);
    return message ? evidenceForSelectedResponse(activeTest, message) : null;
  }, [activeTest, inspectedEvidenceId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    activeTest,
    connection,
    busy,
    error,
    setError,
    streamingText,
    streamingReasoning,
    inspectedEvidence,
    inspect: setInspectedEvidenceId,
    start,
    restart,
    setActive,
    setPresetSource,
    setTestingSettings,
    setComposerDraft,
    send,
    regenerate,
    swipe,
    editMessage,
    stop: () => abortRef.current?.abort(),
    dismissProposal,
    dismissAllProposals,
    runProposal,
    share,
    queueReply,
    updateBatch,
    removeBatchItem,
    setBatchItemNote,
    sendBatch: controller.sendBatch,
  };
}

export type PresetTestingController = ReturnType<typeof usePresetTesting>;
