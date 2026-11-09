import {
  activeCheckpoint,
  type CompactionMessage,
  renderCheckpoint,
} from '@shared/cocreator/compaction.ts';
import { cocreatorBudget } from '@shared/cocreator/generation.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { ChatCompletionBody, ResolvedModel } from '@shared/providers/types.ts';
import type {
  PresetCocreatorMessage,
  PresetCocreatorSession,
} from '@shared/types/preset-cocreator.ts';
import {
  type AssistantWireMessage,
  assistantWireMessages,
  comparisonWireContent,
  configureAssistantMode,
  presetIdentity,
  renderAssistantSystem,
} from './assistant.ts';
import { presetBatchWireContent, presetReportWireContent } from './reportWire.ts';
import { presetToolHistory } from './toolHistory.ts';

export function presetCompactionSources(
  messages: readonly PresetCocreatorMessage[],
): CompactionMessage[] {
  let group = '';
  return messages.map((message): CompactionMessage => {
    if (message.role !== 'tool') group = message.id;
    const content =
      message.role === 'assistant'
        ? JSON.stringify({
            content: message.content,
            ...(message.toolCalls
              ? {
                  toolCalls: message.toolCalls.map((call) => ({
                    id: call.id,
                    function: call.function,
                  })),
                }
              : {}),
          })
        : message.comparison
          ? comparisonWireContent(message.comparison)
          : message.report
            ? presetReportWireContent(message.report)
            : message.batch
              ? presetBatchWireContent(message.batch)
              : message.content;
    const notes = message.report?.note ?? message.batch?.note;
    return {
      id: message.id,
      group,
      role: message.role === 'report' ? 'reference' : message.role,
      content,
      ...(message.role === 'user' &&
      message.appAction !== 'continue' &&
      !message.content.startsWith('Your previous response was interrupted during a tool call.') &&
      !message.content.startsWith('Continue your interrupted answer exactly where it stopped.')
        ? { userText: message.comparison?.focus ?? message.content }
        : notes?.trim()
          ? { userText: notes.trim() }
          : {}),
    };
  });
}
export function buildAssistantRequest(options: {
  session: PresetCocreatorSession;
  messages: readonly PresetCocreatorMessage[];
  model: ResolvedModel;
  contextTokens: number;
  countText(text: string): number;
  referenceNames: readonly string[];
  mode?: 'comparison' | 'conversation';
}) {
  const { session, model, countText } = options;
  const settings = session.document.settings.assistant;
  const preset = createDefaultPreset();
  preset.temperature = settings.temperature;
  preset.openai_max_tokens = settings.maxTokens;
  preset.reasoning_effort = settings.reasoningEffort;
  const budget = cocreatorBudget({
    preset,
    connection: model,
    outputTokens: settings.maxTokens,
    contextTokens: options.contextTokens,
  });
  const repaired = presetToolHistory(options.messages, session.history);
  const sources = presetCompactionSources(repaired);
  const checkpoint = activeCheckpoint(session.document.compaction, sources);
  const system = {
    role: 'system' as const,
    content: renderAssistantSystem(
      session.current,
      session.document.settings.assistantInstructions,
      options.referenceNames,
      presetIdentity(session),
    ),
  };
  const carried = checkpoint
    ? [{ role: 'user' as const, content: renderCheckpoint(checkpoint) }]
    : [];
  const body: ChatCompletionBody & {
    messages: AssistantWireMessage[];
    tools?: unknown;
    tool_choice?: unknown;
  } = {
    ...buildRequestBody({ messages: [], preset, connection: model, stream: true, maxTokens: null }),
    messages: [
      system,
      ...carried,
      ...assistantWireMessages(
        repaired.slice(checkpoint?.coveredMessages ?? 0),
        session.history,
        model,
      ),
    ],
  };
  configureAssistantMode(body, options.mode ?? 'conversation');
  const tools = body.tools ? countText(JSON.stringify(body.tools)) : 0;
  return {
    body,
    preset,
    budget,
    sources,
    used: countText(JSON.stringify(body.messages)) + tools,
    fixed: countText(JSON.stringify([system])) + tools,
    summary: carried.length ? countText(JSON.stringify(carried)) : 0,
  };
}
