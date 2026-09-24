import type { Connection } from '@shared/providers/types.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import type {
  PresetTest,
  PresetTestEvidence,
  PresetTestReport,
  PresetTestScenario,
  ProposedPresetTest,
} from '@shared/types/preset-cocreator.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamGenerate } from '../../lib/api.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import {
  appendPresetTestUserMessage,
  buildPresetTestReport,
  createPresetTest,
  dismissPendingProposals,
  editPresetTestMessage,
  evidenceForSelectedResponse,
  type PresetTestGenerationKind,
  preparePresetTestRequest,
  restartPresetTest,
  selectPresetTestSwipe,
  settlePresetTestGeneration,
  updateProposedTest,
} from './testing.ts';
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
  const sessionRef = useRef(controller.session);
  sessionRef.current = controller.session;

  const setting = controller.session.document.settings.testing;
  const connection = useMemo(() => {
    const selected =
      connections.find((entry) => entry.id === setting.connectionId) ?? connections[0] ?? null;
    return selected ? { ...selected, model: setting.model.trim() || selected.model } : null;
  }, [connections, setting.connectionId, setting.model]);
  const countTokens = useTokenizer(connection?.model ?? '', tokenizerEncoding);

  const activeTest = useMemo(
    () =>
      controller.session.document.tests.find(
        (test) => test.id === controller.session.document.activeTestId,
      ) ?? null,
    [controller.session.document.activeTestId, controller.session.document.tests],
  );

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
    (scenario: PresetTestScenario, title?: string) => saveTest(createPresetTest(scenario, title)),
    [saveTest],
  );

  const restart = useCallback(
    (test = activeTest) => (test ? saveTest(restartPresetTest(test)) : null),
    [activeTest, saveTest],
  );

  const setActive = useCallback(
    (id: string) =>
      controller.updateDocument((document) =>
        document.tests.some((test) => test.id === id)
          ? { ...document, activeTestId: id }
          : document,
      ),
    [controller],
  );

  const generate = useCallback(
    async (kind: PresetTestGenerationKind, baseTest: PresetTest) => {
      if (busy) return;
      if (!connection) {
        setError('Choose a testing connection and model.');
        return;
      }
      const draft = structuredClone(sessionRef.current.current);
      const requestConnection = { ...connection };
      const prepared = preparePresetTestRequest({
        test: structuredClone(baseTest),
        kind,
        preset: draft.preset,
        connection: requestConnection,
        countTokens,
      });
      if (!prepared) {
        setError('There is no assistant response to regenerate or swipe.');
        return;
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
        draftRevision: draft.revision,
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
        return;
      }

      const controllerAbort = new AbortController();
      abortRef.current = controllerAbort;
      setBusy(true);
      setError(null);
      setStreamingText('');
      setStreamingReasoning('');
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
        if (abortRef.current === controllerAbort) abortRef.current = null;
        setBusy(false);
        setStreamingText('');
        setStreamingReasoning('');
      }
    },
    [busy, connection, countTokens, saveTest],
  );

  const send = useCallback(
    async (text: string, test = activeTest) => {
      if (!test || busy) return;
      const withUser = appendPresetTestUserMessage(test, text, sessionRef.current.current.preset);
      if (!withUser) return;
      saveTest(withUser);
      await generate('send', withUser);
    },
    [activeTest, busy, generate, saveTest],
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
      const withUser = appendPresetTestUserMessage(
        target,
        editedMessage,
        sessionRef.current.current.preset,
      );
      if (!withUser) return;
      controller.updateDocument((document) => ({
        ...document,
        tests: document.tests.some((entry) => entry.id === withUser.id)
          ? document.tests.map((entry) => (entry.id === withUser.id ? withUser : entry))
          : [...document.tests, withUser],
        activeTestId: withUser.id,
        proposedTests: updateProposedTest(document.proposedTests, proposal.id, 'run'),
      }));
      await generate('send', withUser);
    },
    [activeTest, busy, controller, generate],
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
    send,
    regenerate,
    swipe,
    editMessage,
    stop: () => abortRef.current?.abort(),
    dismissProposal,
    dismissAllProposals,
    runProposal,
    share,
  };
}

export type PresetTestingController = ReturnType<typeof usePresetTesting>;
