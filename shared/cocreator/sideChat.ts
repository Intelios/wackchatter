import { currentText, type MessageState } from '../chat/message.ts';
import { type ModelSlots, normalizeModelRef, resolveModelRef, slotRef } from '../models/slots.ts';
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
  const model = normalizeModelRef(value.model);
  if (model) result.model = model;
  for (const key of ['outputTokens', 'contextTokens'] as const) {
    const limit = value[key];
    if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 && limit <= 2097152) {
      result[key] = limit;
    }
  }
  return result;
}

export function normalizeSideDefaults(raw: unknown): SideChatDefaults {
  const { outputTokens, contextTokens } = normalizeSideSettings(raw);
  return {
    outputTokens: outputTokens ?? DEFAULT_SIDE_CHAT.outputTokens,
    contextTokens: contextTokens ?? DEFAULT_SIDE_CHAT.contextTokens,
  };
}

/**
 * The side chat's model and allowances: the session's own pick, else the `sideChat` slot.
 * A missing model is a block, never an invitation to spend on another one — the slot does
 * not follow chat.
 */
export function resolveSideSettings(
  defaults: SideChatDefaults,
  settings: SideChatModelSettings,
  slots: ModelSlots,
  connections: readonly Connection[],
) {
  return {
    model: resolveModelRef(connections, settings.model ?? slotRef(slots, 'sideChat'), 'side chat'),
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
