/**
 * Default prompts and prompt order, matching SillyTavern's built-ins exactly.
 *
 * A preset that omits any of these gets them back — real ST calls checkForMissingPrompts()
 * on load and silently re-injects them, so a file lacking them would drift the moment it
 * was opened in SillyTavern.
 */

import type { Preset, Prompt, PromptOrderEntry } from '../types/preset.ts';
import { PROMPT_ORDER_LIVE_ID } from '../types/preset.ts';

export const DEFAULT_MAIN_PROMPT =
  "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.";

export const DEFAULT_ENHANCE_DEFINITIONS_PROMPT =
  "If you have more knowledge of {{char}}, add to the character's lore and personality to " +
  "enhance them but keep the Character Sheet's definitions absolute.";

export const DEFAULT_IMPERSONATION_PROMPT =
  '[Write your next reply from the point of view of {{user}}, using the chat history so far ' +
  "as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. " +
  "Don't describe actions of {{char}}.]";

export const DEFAULT_CONTINUE_NUDGE_PROMPT =
  '[Continue your last message without repeating its original content.]';

/** The 12 built-in prompts, in SillyTavern's declaration order. */
export const DEFAULT_PROMPTS: Prompt[] = [
  {
    name: 'Main Prompt',
    system_prompt: true,
    role: 'system',
    content: DEFAULT_MAIN_PROMPT,
    identifier: 'main',
  },
  {
    name: 'Auxiliary Prompt',
    system_prompt: true,
    role: 'system',
    content: '',
    identifier: 'nsfw',
  },
  { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
  {
    name: 'Post-History Instructions',
    system_prompt: true,
    role: 'system',
    content: '',
    identifier: 'jailbreak',
  },
  { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
  { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
  { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
  {
    identifier: 'enhanceDefinitions',
    role: 'system',
    name: 'Enhance Definitions',
    content: DEFAULT_ENHANCE_DEFINITIONS_PROMPT,
    system_prompt: true,
    marker: false,
  },
  { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
  { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
  { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
  {
    identifier: 'personaDescription',
    name: 'Persona Description',
    system_prompt: true,
    marker: true,
  },
];

/** The default order, as seeded for character_id 100001. */
export const DEFAULT_PROMPT_ORDER: PromptOrderEntry[] = [
  { identifier: 'main', enabled: true },
  { identifier: 'worldInfoBefore', enabled: true },
  { identifier: 'personaDescription', enabled: true },
  { identifier: 'charDescription', enabled: true },
  { identifier: 'charPersonality', enabled: true },
  { identifier: 'scenario', enabled: true },
  { identifier: 'enhanceDefinitions', enabled: false },
  { identifier: 'nsfw', enabled: true },
  { identifier: 'worldInfoAfter', enabled: true },
  { identifier: 'dialogueExamples', enabled: true },
  { identifier: 'chatHistory', enabled: true },
  { identifier: 'jailbreak', enabled: true },
];

/** Preset defaults, keyed by the preset-file field name. */
export const PRESET_DEFAULTS = {
  chat_completion_source: 'custom',
  temperature: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  top_p: 1,
  top_k: 0,
  top_a: 0,
  min_p: 0,
  repetition_penalty: 1,
  openai_max_context: 4095,
  openai_max_tokens: 300,
  max_context_unlocked: false,
  names_behavior: 0,
  send_if_empty: '',
  impersonation_prompt: DEFAULT_IMPERSONATION_PROMPT,
  new_chat_prompt: '[Start a new Chat]',
  new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
  new_example_chat_prompt: '[Example Chat]',
  continue_nudge_prompt: DEFAULT_CONTINUE_NUDGE_PROMPT,
  group_nudge_prompt: '[Write the next reply only as {{char}}.]',
  bias_preset_selected: 'Default (none)',
  wi_format: '{0}',
  scenario_format: '{{scenario}}',
  personality_format: '{{personality}}',
  stream_openai: true,
  squash_system_messages: false,
  continue_prefill: false,
  continue_postfix: ' ',
  seed: -1,
  n: 1,
  reasoning_effort: 'auto',
} as const satisfies Partial<Preset>;

export function createDefaultPreset(): Preset {
  return {
    ...PRESET_DEFAULTS,
    prompts: structuredClone(DEFAULT_PROMPTS),
    prompt_order: [
      { character_id: PROMPT_ORDER_LIVE_ID, order: structuredClone(DEFAULT_PROMPT_ORDER) },
    ],
  };
}
