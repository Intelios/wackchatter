/**
 * Macro resolution for the display path.
 *
 * Everything here runs while rendering the transcript, which is why every entry point
 * builds a FRESH runtime and throws it away: a `{{setvar}}` in a greeting or in a regex
 * script's replacement would otherwise fire on every render, and scrolling would quietly
 * rewrite the chat's variables. The prompt path deliberately does the opposite — there the
 * runtime is assembly's, and the write is the point.
 */

import type { RegexMacros } from '../regex/engine.ts';
import { sanitizeRegexMacro } from '../regex/engine.ts';
import type { CardDataV2 } from '../types/card.ts';
import type { ChatMessage, ChatMetadata, MacroVariableMap, Persona } from '../types/chat.ts';
import type { Preset } from '../types/preset.ts';
import { DEFAULT_USER_NAME } from './assemble.ts';
import { createMacroRuntime, type MacroEnvironment, substituteMacros } from './macros.ts';

export interface GreetingMacroOptions {
  character: CardDataV2;
  preset: Preset;
  persona?: Persona | null;
  messages: ChatMessage[];
  metadata?: ChatMetadata;
  globalVariables?: MacroVariableMap;
  seed?: string;
}

/** The same environment assembly builds, minus anything that only a prompt has. */
function displayEnvironment(options: GreetingMacroOptions): MacroEnvironment {
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

/** Resolve a greeting for display while leaving its stored text and all variable maps untouched. */
export function resolveGreetingMacros(text: string, options: GreetingMacroOptions): string {
  return substituteMacros(text, displayEnvironment(options), options.seed ?? '', {
    runtime: createMacroRuntime(options.metadata?.variables ?? {}, options.globalVariables ?? {}),
    source: 'greeting',
  });
}

/**
 * Macro hooks for regex scripts on the display path.
 *
 * The runtime is built once per call and never read back, so a script whose replacement
 * contains `{{setvar}}` can write to it all it likes and nothing survives the render. On
 * the prompt path the same script really does set the variable, which is SillyTavern's
 * behaviour and the reason these two are built in different places.
 */
export function createDisplayRegexMacros(options: GreetingMacroOptions): RegexMacros {
  const env = displayEnvironment(options);
  const seed = options.seed ?? '';
  const local = options.metadata?.variables ?? {};
  const global = options.globalVariables ?? {};

  return {
    expand: (text, source) =>
      substituteMacros(text, env, seed, { runtime: createMacroRuntime(local, global), source }),
    expandEscaped: (text, source) =>
      substituteMacros(text, env, seed, {
        runtime: createMacroRuntime(local, global),
        source,
        postProcess: sanitizeRegexMacro,
      }),
  };
}
