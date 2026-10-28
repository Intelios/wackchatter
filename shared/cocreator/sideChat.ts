import { currentText, type MessageState } from '../chat/message.ts';
import type { Connection } from '../providers/types.ts';
import {
  DEFAULT_SIDE_CHAT,
  type SideChatDefaults,
  type SideChatModelSettings,
  type SideChatSnapshot,
} from '../types/cocreator.ts';

export function normalizeSideSettings(raw: unknown): SideChatModelSettings {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const result: SideChatModelSettings = {};
  if (typeof value.connectionId === 'string' || value.connectionId === null) {
    result.connectionId = value.connectionId;
  }
  for (const key of ['outputTokens', 'contextTokens'] as const) {
    const limit = value[key];
    if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 && limit <= 2097152) {
      result[key] = limit;
    }
  }
  const override = value.modelOverride as Partial<
    NonNullable<SideChatModelSettings['modelOverride']>
  > | null;
  if (
    override &&
    typeof override.connectionId === 'string' &&
    typeof override.model === 'string' &&
    override.model.trim()
  ) {
    result.modelOverride = { connectionId: override.connectionId, model: override.model.trim() };
  }
  return result;
}

export function normalizeSideDefaults(raw: unknown): SideChatDefaults {
  return { ...DEFAULT_SIDE_CHAT, ...normalizeSideSettings(raw) };
}

/** A missing saved endpoint is a block, never an invitation to spend on another one. */
export function resolveSideSettings(
  defaults: SideChatDefaults,
  settings: SideChatModelSettings,
  connections: readonly Connection[],
) {
  const connectionId =
    settings.connectionId === undefined ? defaults.connectionId : settings.connectionId;
  const saved = connections.find((entry) => entry.id === connectionId) ?? null;
  // A session's explicit endpoint/model choice takes precedence over the app default.
  const override =
    settings.modelOverride ??
    (settings.connectionId === undefined ? defaults.modelOverride : undefined);
  const connection =
    saved && override?.connectionId === saved.id ? { ...saved, model: override.model } : saved;
  return {
    connection,
    outputTokens: settings.outputTokens ?? defaults.outputTokens,
    contextTokens: settings.contextTokens ?? defaults.contextTokens,
  };
}

export function captureSideSnapshot(input: {
  systemPrompt: string;
  exampleBlock: string;
  messages: readonly MessageState[];
  capturedAt?: number;
}): SideChatSnapshot {
  return {
    capturedAt: input.capturedAt ?? Date.now(),
    systemPrompt: input.systemPrompt,
    exampleBlock: input.exampleBlock,
    messages: input.messages
      .filter((message) => currentText(message).trim())
      .map((message) => ({
        role: message.is_user ? 'user' : 'assistant',
        content: currentText(message),
      })),
  };
}

export function appendDraft(current: string, text: string): string {
  return current.trimEnd() ? `${current.trimEnd()}\n\n${text}` : text;
}

export function quoteForSideChat(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\n`;
}
