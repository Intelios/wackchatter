import {
  appendAlternates,
  appendSwipe,
  assistantPlaceholder,
  fromChatMessage,
  greetingTexts,
  resetSwipes,
  selectSwipe,
  setText,
  timestamp,
  toChatMessage,
  userMessage,
} from '@shared/chat/message.ts';
import { assemblePrompt, DEFAULT_USER_NAME } from '@shared/prompt/assemble.ts';
import { resolveOutgoingMacros } from '@shared/prompt/outgoing.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { ChatMessage, SwipeInfo } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type {
  PresetCocreatorMessage,
  PresetTest,
  PresetTestEvidence,
  PresetTestReport,
  PresetTestScenario,
  ProposedPresetTest,
} from '@shared/types/preset-cocreator.ts';
import { worldInfoForChat } from '../lore/worldInfoForChat.ts';

export type PresetTestGenerationKind = 'send' | 'regenerate' | 'swipe';

export function createPresetTest(
  scenario: PresetTestScenario,
  title = `Test ${new Date().toLocaleString()}`,
): PresetTest {
  const greeting = greetingTexts(scenario.character)[scenario.greetingIndex] ?? '';
  const now = Date.now();
  const messages: ChatMessage[] = greeting
    ? [
        {
          id: crypto.randomUUID(),
          name: scenario.character.name,
          is_user: false,
          is_system: false,
          mes: greeting,
          send_date: timestamp(),
          swipes: [greeting],
          swipe_id: 0,
          swipe_info: [{ send_date: timestamp() }],
        },
      ]
    : [];
  return {
    id: crypto.randomUUID(),
    title,
    created: now,
    modified: now,
    scenario: structuredClone(scenario),
    localVariables: structuredClone(scenario.variables.local),
    globalVariables: structuredClone(scenario.variables.global),
    messages,
    evidence: [],
  };
}

export function restartPresetTest(test: PresetTest): PresetTest {
  return createPresetTest(test.scenario, `${test.title} — restarted`);
}

function replaceMessage(messages: ChatMessage[], replacement: ChatMessage): ChatMessage[] {
  return messages.map((message) => (message.id === replacement.id ? replacement : message));
}

function latestAssistant(messages: readonly ChatMessage[]): ChatMessage | null {
  return [...messages].reverse().find((message) => !message.is_user) ?? null;
}

/** Build the exact transcript shape normal chat generation gives the assembler. */
export function preparePresetTestGeneration(
  test: PresetTest,
  kind: PresetTestGenerationKind,
): { messages: ChatMessage[]; target: ChatMessage; replacedResponse?: string } | null {
  if (kind === 'send') {
    const target = toChatMessage(
      assistantPlaceholder(crypto.randomUUID(), test.scenario.character.name),
    );
    return { messages: [...test.messages, target], target };
  }
  const existing = latestAssistant(test.messages);
  if (!existing) return null;
  const state = fromChatMessage(existing);
  const replacedResponse = existing.mes;
  const next = kind === 'regenerate' ? resetSwipes(state) : appendSwipe(state, '');
  const target = toChatMessage(next);
  return {
    messages: replaceMessage(test.messages, target),
    target,
    ...(kind === 'regenerate' ? { replacedResponse } : {}),
  };
}

export interface PreparedPresetTestRequest {
  messages: ChatMessage[];
  target: ChatMessage;
  body: Record<string, unknown> | null;
  assembled: ReturnType<typeof assemblePrompt>;
  worldInfo: ReturnType<typeof worldInfoForChat>;
  replacedResponse?: string;
}

export function preparePresetTestRequest(options: {
  test: PresetTest;
  kind: PresetTestGenerationKind;
  preset: Preset;
  connection: Connection;
  countTokens: TokenCounter;
}): PreparedPresetTestRequest | null {
  const prepared = preparePresetTestGeneration(options.test, options.kind);
  if (!prepared) return null;
  const lore = worldInfoForChat({
    sources: options.test.scenario.worldInfoSources,
    messages: prepared.messages,
    settings: options.test.scenario.worldInfoSettings,
    preset: options.preset,
    chatId: options.test.id,
    countTokens: options.countTokens,
  });
  const assembled = assemblePrompt({
    preset: options.preset,
    character: options.test.scenario.character,
    persona: options.test.scenario.persona,
    messages: prepared.messages,
    worldInfoBefore: lore?.before,
    worldInfoAfter: lore?.after,
    worldInfoDepth: lore?.depth,
    memoryMode: 'off',
    localVariables: options.test.localVariables,
    globalVariables: options.test.globalVariables,
    countTokens: options.countTokens,
    seed: options.test.id,
    regexScripts: options.test.scenario.regexScripts,
  });
  return {
    ...prepared,
    assembled,
    worldInfo: lore,
    body: assembled.ok
      ? buildRequestBody({
          messages: assembled.messages,
          preset: options.preset,
          connection: options.connection,
          stream: options.preset.stream_openai !== false,
          completions: Math.max(1, Math.trunc(options.preset.n ?? 1)),
        })
      : null,
  };
}

export function appendPresetTestUserMessage(
  test: PresetTest,
  text: string,
  preset: Preset,
): PresetTest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const resolved = resolveOutgoingMacros(trimmed, {
    character: test.scenario.character,
    preset,
    persona: test.scenario.persona,
    messages: test.messages,
    metadata: { variables: test.localVariables },
    globalVariables: test.globalVariables,
    seed: test.id,
  });
  if (!resolved.text.trim()) return null;
  const message = toChatMessage(
    userMessage(
      crypto.randomUUID(),
      test.scenario.persona?.name ?? DEFAULT_USER_NAME,
      resolved.text,
      test.scenario.persona?.id ?? null,
    ),
  );
  return {
    ...test,
    modified: Date.now(),
    localVariables: resolved.local,
    globalVariables: resolved.global,
    messages: [...test.messages, message],
  };
}

export interface SettlePresetTestOptions {
  test: PresetTest;
  prepared: PreparedPresetTestRequest;
  evidence: PresetTestEvidence[];
  text: string;
  reasoning: string;
  alternates?: Array<{ text: string; info: SwipeInfo; evidence: PresetTestEvidence }>;
  keepEmptyTarget?: boolean;
}

export function settlePresetTestGeneration(options: SettlePresetTestOptions): PresetTest {
  const current = fromChatMessage(options.prepared.target);
  let settled = setText(current, options.text, {
    gen_finished: timestamp(),
    extra: {
      ...(current.swipe_info[current.swipe_id]?.extra ?? {}),
      preset_revision: options.evidence[0]?.draftRevision,
      preset_test_evidence_id: options.evidence[0]?.id,
      model: options.evidence[0]?.model,
      connection_id: options.evidence[0]?.connectionId,
      generation_id: options.evidence[0]?.generationId,
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    },
  });
  if (options.alternates?.length) {
    settled = appendAlternates(
      settled,
      options.alternates.map((alternate) => ({
        text: alternate.text,
        info: {
          ...alternate.info,
          extra: {
            ...(alternate.info.extra ?? {}),
            preset_revision: alternate.evidence.draftRevision,
            preset_test_evidence_id: alternate.evidence.id,
          },
        },
      })),
    );
  }
  let messages = options.prepared.messages;
  if (!options.text && !options.keepEmptyTarget) {
    messages = messages.filter((message) => message.id !== options.prepared.target.id);
  } else {
    messages = replaceMessage(messages, toChatMessage(settled));
  }
  return {
    ...options.test,
    modified: Date.now(),
    messages,
    evidence: [...options.test.evidence, ...options.evidence],
    localVariables: options.prepared.assembled.variableUpdates.local,
    globalVariables: options.prepared.assembled.variableUpdates.global,
  };
}

export function selectPresetTestSwipe(
  test: PresetTest,
  messageId: string,
  index: number,
): PresetTest {
  const message = test.messages.find((entry) => entry.id === messageId);
  if (!message) return test;
  const selected = selectSwipe(fromChatMessage(message), index);
  if (selected.swipe_id === message.swipe_id) return test;
  return {
    ...test,
    modified: Date.now(),
    messages: replaceMessage(test.messages, toChatMessage(selected)),
  };
}

export function editPresetTestMessage(
  test: PresetTest,
  messageId: string,
  text: string,
): PresetTest {
  const message = test.messages.find((entry) => entry.id === messageId);
  if (!message) return test;
  const edited = toChatMessage(setText(fromChatMessage(message), text));
  return { ...test, modified: Date.now(), messages: replaceMessage(test.messages, edited) };
}

export function evidenceForSelectedResponse(
  test: PresetTest,
  message: ChatMessage,
): PresetTestEvidence | null {
  const id = message.extra?.preset_test_evidence_id;
  return typeof id === 'string' ? (test.evidence.find((entry) => entry.id === id) ?? null) : null;
}

export function buildPresetTestReport(options: {
  test: PresetTest;
  throughMessageId: string;
  note: string;
  includeTranscript: boolean;
  includePrompt: boolean;
  includeDiagnostics: boolean;
}): PresetTestReport {
  const index = options.test.messages.findIndex(
    (message) => message.id === options.throughMessageId,
  );
  if (index < 0) throw new Error('Choose a response from the test conversation.');
  const through = options.test.messages[index]!;
  const sourceEvidence = evidenceForSelectedResponse(options.test, through);
  let evidence: PresetTestEvidence | undefined;
  if (sourceEvidence && (options.includePrompt || options.includeDiagnostics)) {
    evidence = structuredClone(sourceEvidence);
    if (!options.includePrompt) {
      evidence.messages = [];
      evidence.body = null;
    }
    if (!options.includeDiagnostics) {
      evidence.tokenCounts = {};
      evidence.totalTokens = 0;
      evidence.droppedMessages = 0;
      evidence.macroWarnings = [];
      delete evidence.worldInfo;
      delete evidence.promptTokens;
      delete evidence.completionTokens;
    }
  }
  return {
    id: crypto.randomUUID(),
    created: Date.now(),
    testId: options.test.id,
    throughMessageId: options.throughMessageId,
    note: options.note,
    includeTranscript: options.includeTranscript,
    includePrompt: options.includePrompt,
    includeDiagnostics: options.includeDiagnostics,
    ...(options.includeTranscript
      ? { transcript: structuredClone(options.test.messages.slice(0, index + 1)) }
      : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function reportConversationMessage(report: PresetTestReport): PresetCocreatorMessage {
  return {
    id: crypto.randomUUID(),
    role: 'report',
    created: Date.now(),
    report: structuredClone(report),
    content: `Shared preset test report (immutable data):\n${JSON.stringify(report, null, 2)}`,
  };
}

export function updateProposedTest(
  proposals: ProposedPresetTest[],
  id: string,
  status: ProposedPresetTest['status'],
): ProposedPresetTest[] {
  return proposals.map((proposal) => (proposal.id === id ? { ...proposal, status } : proposal));
}
