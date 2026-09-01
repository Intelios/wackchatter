/**
 * The macro environment a chat screen has, as opposed to the one an assembly has.
 *
 * Assembly builds its own from the same pieces plus everything only a prompt knows — the
 * reserved completion size, the model id, the scenario override in play for that request.
 * This is the smaller one, shared by every caller that starts from "a character, a preset, a
 * persona and a transcript": the greeting renderer, the transcript's regex pass, and the
 * send path.
 *
 * It lives on its own so those callers cannot drift apart. Two copies of this would mean two
 * definitions of `{{lastMessage}}`, and the disagreement would only ever show up as a
 * greeting quoting a different message than the prompt did.
 */

import type { CardDataV2 } from '../types/card.ts';
import type { ChatMessage, ChatMetadata, MacroVariableMap, Persona } from '../types/chat.ts';
import type { Preset } from '../types/preset.ts';
import { DEFAULT_USER_NAME } from './assemble.ts';
import type { MacroEnvironment } from './macros.ts';

export interface ChatMacroOptions {
  character: CardDataV2;
  preset: Preset;
  persona?: Persona | null;
  messages: ChatMessage[];
  metadata?: ChatMetadata;
  globalVariables?: MacroVariableMap;
  seed?: string;
}

/** The same environment assembly builds, minus anything that only a prompt has. */
export function chatEnvironment(options: ChatMacroOptions): MacroEnvironment {
  const { character, preset, persona, messages, metadata = {} } = options;
  const effectiveScenario =
    typeof metadata.scenario === 'string' ? metadata.scenario : character.scenario;

  return {
    char: character.name,
    user: persona?.name ?? DEFAULT_USER_NAME,
    description: character.description,
    personality: character.personality,
    scenario: effectiveScenario,
    persona: persona?.description ?? '',
    mesExamples: character.mes_example,
    charVersion: character.character_version,
    charPrompt: character.system_prompt,
    charJailbreak: character.post_history_instructions,
    creatorNotes: character.creator_notes,
    maxContext: preset.openai_max_context ?? 4095,
    maxResponse: preset.openai_max_tokens ?? 300,
    lastMessage: messages.at(-1)?.mes ?? '',
    lastUserMessage: [...messages].reverse().find((message) => message.is_user)?.mes ?? '',
    lastCharMessage: [...messages].reverse().find((message) => !message.is_user)?.mes ?? '',
  };
}
