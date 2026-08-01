import type { CardDataV2 } from '../types/card.ts';
import type { ChatMessage, ChatMetadata, MacroVariableMap, Persona } from '../types/chat.ts';
import type { Preset } from '../types/preset.ts';
import { DEFAULT_USER_NAME } from './assemble.ts';
import { createMacroRuntime, substituteMacros } from './macros.ts';

export interface GreetingMacroOptions {
  character: CardDataV2;
  preset: Preset;
  persona?: Persona | null;
  messages: ChatMessage[];
  metadata?: ChatMetadata;
  globalVariables?: MacroVariableMap;
  seed?: string;
}

/** Resolve a greeting for display while leaving its stored text and all variable maps untouched. */
export function resolveGreetingMacros(text: string, options: GreetingMacroOptions): string {
  const {
    character,
    preset,
    persona,
    messages,
    metadata = {},
    globalVariables = {},
    seed = '',
  } = options;
  const effectiveScenario =
    typeof metadata.scenario === 'string' ? metadata.scenario : character.scenario;

  return substituteMacros(
    text,
    {
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
    },
    seed,
    {
      runtime: createMacroRuntime(metadata.variables ?? {}, globalVariables),
      source: 'greeting',
    },
  );
}
