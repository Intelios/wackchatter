import { currentText, type MessageState, userMessage } from '@shared/chat/message.ts';
import { CONTINUE_DESIGN_REPLY, cocreatorBudget } from '@shared/cocreator/generation.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { ChatCompletionBody, ResolvedModel } from '@shared/providers/types.ts';
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
  connection: ResolvedModel;
  settings: SessionModelSettings;
  systemPrompt: string;
  exampleBlock: string;
  draftBlock?: string;
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
        draftBlock: input.draftBlock,
        messages: promptMessages,
        countTokens: input.countTokens,
        maxPromptTokens: budget.promptTokens,
      });
  if (prompt.fixedOverflow) {
    throw new Error(
      input.sideSnapshot
        ? "The frozen instructions, card and examples don't fit the side chat's model. Choose a larger model or start the side chat fresh with less context."
        : 'The instructions, current card and examples do not fit this model. Choose a larger model or reduce the card or examples.',
    );
  }
  const visibleCount = promptMessages.filter((message) => currentText(message).trim()).length;
  const dropped =
    'droppedSideMessages' in prompt ? prompt.droppedSideMessages : prompt.droppedMessages;
  if (dropped > visibleCount - (mode === 'continue' ? 2 : 1)) {
    throw new Error(
      input.sideSnapshot
        ? "The latest side message doesn't fit the side chat's model."
        : "The latest message doesn't fit this model.",
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
        // No cap: the budget above only reserves room. A cap cut long cards off.
        maxTokens: null,
      }),
      messages: prompt.messages,
    },
  };
}
