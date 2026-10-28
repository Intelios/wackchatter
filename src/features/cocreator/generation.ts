import { currentText, type MessageState, userMessage } from '@shared/chat/message.ts';
import { CONTINUE_DESIGN_REPLY, cocreatorBudget } from '@shared/cocreator/generation.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { ChatCompletionBody, Connection } from '@shared/providers/types.ts';
import type { ApiMessage } from '@shared/types/chat.ts';
import type { SessionModelSettings, SideChatSnapshot } from '@shared/types/cocreator.ts';
import type { Preset } from '@shared/types/preset.ts';
import { buildDesignPrompt } from './prompt.ts';
import { buildSidePrompt } from './sidePrompt.ts';

/** Build before contacting a provider: a request must include what it is answering. */
export function buildDesignGeneration(input: {
  mode: 'send' | 'swipe' | 'continue';
  messages: MessageState[];
  preset: Preset;
  connection: Connection;
  settings: SessionModelSettings;
  systemPrompt: string;
  exampleBlock: string;
  countTokens: TokenCounter;
  streaming: boolean;
  sideSnapshot?: SideChatSnapshot;
}): { prefix: string; body: ChatCompletionBody & { messages: ApiMessage[] } } {
  const { mode, messages, preset, connection, settings, streaming } = input;
  const prefix = mode === 'continue' ? currentText(messages.at(-1)!) : '';
  const promptMessages =
    mode === 'continue'
      ? [
          ...messages,
          userMessage(
            crypto.randomUUID(),
            'You',
            prefix.trim()
              ? CONTINUE_DESIGN_REPLY
              : 'Your interrupted attempt produced no visible answer. Answer my last design request now.',
            null,
          ),
        ]
      : messages;
  const budget = cocreatorBudget({
    preset,
    connection,
    stream: streaming,
    outputTokens: settings.outputTokens,
    contextTokens: settings.contextTokens,
  });
  const prompt = input.sideSnapshot
    ? buildSidePrompt({
        snapshot: input.sideSnapshot,
        messages: promptMessages,
        countTokens: input.countTokens,
        maxPromptTokens: budget.promptTokens,
      })
    : buildDesignPrompt({
        systemPrompt: input.systemPrompt,
        exampleBlock: input.exampleBlock,
        messages: promptMessages,
        countTokens: input.countTokens,
        maxPromptTokens: budget.promptTokens,
      });
  if (prompt.fixedOverflow) {
    throw new Error(
      input.sideSnapshot
        ? 'The frozen instructions and examples exceed the side-chat context budget. Raise the side context size or start fresh with fewer examples.'
        : 'The system prompt and attached examples alone exceed the Co-Creator context budget. Detach an example, turn off some example fields, or raise the context size in setup.',
    );
  }
  const visibleCount = promptMessages.filter((message) => currentText(message).trim()).length;
  const dropped =
    'droppedSideMessages' in prompt ? prompt.droppedSideMessages : prompt.droppedMessages;
  if (dropped > visibleCount - (mode === 'continue' ? 2 : 1)) {
    throw new Error(
      input.sideSnapshot
        ? 'The latest side message cannot fit in the side-chat context budget. Raise the context size or lower the output limit.'
        : 'The latest message cannot fit in the Co-Creator context budget. Raise the context size or lower the output limit in setup.',
    );
  }
  return {
    prefix,
    body: {
      ...buildRequestBody({
        messages: prompt.messages,
        preset,
        connection,
        stream: streaming,
        maxTokens: budget.maxTokens,
      }),
      messages: prompt.messages,
    },
  };
}
