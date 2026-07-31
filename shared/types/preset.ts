/**
 * Chat-completion preset types, matching SillyTavern's `OpenAI Settings/*.json` format.
 *
 * Two facts that are easy to get wrong and break compatibility silently:
 *  - `enabled` lives on the PROMPT ORDER ENTRY, not on the prompt object. `Prompt.enabled`
 *    exists in ST's class but is never read when deciding what to send.
 *  - The live `character_id` is 100001, not 100000. A 100000 entry is legacy; preserve it
 *    untouched if present but never read from it.
 */

export const INJECTION_POSITION = {
  RELATIVE: 0,
  ABSOLUTE: 1,
} as const;

export type InjectionPosition = (typeof INJECTION_POSITION)[keyof typeof INJECTION_POSITION];

export const DEFAULT_INJECTION_DEPTH = 4;
export const DEFAULT_INJECTION_ORDER = 100;

/** The character_id the live prompt order is stored under. */
export const PROMPT_ORDER_LIVE_ID = 100001;
/** Legacy id found in older presets. Preserved on write, never read. */
export const PROMPT_ORDER_LEGACY_ID = 100000;

export type PromptRole = 'system' | 'user' | 'assistant';

export type GenerationType =
  | 'normal'
  | 'continue'
  | 'impersonate'
  | 'swipe'
  | 'regenerate'
  | 'quiet';

export interface Prompt {
  identifier: string;
  name: string;
  role?: PromptRole;
  content?: string;
  system_prompt?: boolean;
  /** True = content is synthesized at generation time from live state, not stored here. */
  marker?: boolean;
  injection_position?: InjectionPosition;
  injection_depth?: number;
  injection_order?: number;
  /** Empty or absent = always triggers. */
  injection_trigger?: GenerationType[];
  /** Only meaningful for `main` and `jailbreak`: blocks character-card overrides. */
  forbid_overrides?: boolean;
  /** Set by ST when a prompt is injected by an extension. */
  extension?: boolean;
  /** Vestigial — see file header. Preserved on round-trip. */
  enabled?: boolean;
  [key: string]: unknown;
}

export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

export interface PromptOrderList {
  character_id: number;
  order: PromptOrderEntry[];
}

export const CHARACTER_NAMES_BEHAVIOR = {
  NONE: -1,
  DEFAULT: 0,
  COMPLETION: 1,
  CONTENT: 2,
} as const;

export type CharacterNamesBehavior =
  (typeof CHARACTER_NAMES_BEHAVIOR)[keyof typeof CHARACTER_NAMES_BEHAVIOR];

/**
 * A preset. Typed for the fields we act on; the index signature carries everything else
 * through untouched so a preset can round-trip via SillyTavern without losing provider
 * settings we don't implement.
 */
export interface Preset {
  chat_completion_source?: string;

  // Samplers
  temperature?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  top_p?: number;
  top_k?: number;
  top_a?: number;
  min_p?: number;
  repetition_penalty?: number;
  seed?: number;
  n?: number;

  // Budget
  openai_max_context?: number;
  openai_max_tokens?: number;
  max_context_unlocked?: boolean;

  // Assembly behaviour
  names_behavior?: CharacterNamesBehavior;
  squash_system_messages?: boolean;
  send_if_empty?: string;
  wi_format?: string;
  scenario_format?: string;
  personality_format?: string;
  new_chat_prompt?: string;
  new_group_chat_prompt?: string;
  new_example_chat_prompt?: string;
  continue_nudge_prompt?: string;
  group_nudge_prompt?: string;
  impersonation_prompt?: string;
  continue_prefill?: boolean;
  continue_postfix?: string;
  stream_openai?: boolean;

  // The core of the format
  prompts?: Prompt[];
  prompt_order?: PromptOrderList[];

  extensions?: Record<string, unknown>;

  [key: string]: unknown;
}

/** Preset as surfaced to the UI. */
export interface PresetSummary {
  /** Filename without extension — the unique ID. */
  id: string;
  name: string;
  modified: number;
}

// ---------------------------------------------------------------------------
// Built-in prompt identifiers
// ---------------------------------------------------------------------------

/** Markers: content is synthesized at generation time, never stored in the preset. */
export const MARKER_IDENTIFIERS = [
  'dialogueExamples',
  'chatHistory',
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
] as const;

/** Built-in prompts whose text the user edits directly. */
export const EDITABLE_BUILTIN_IDENTIFIERS = [
  'main',
  'nsfw',
  'jailbreak',
  'enhanceDefinitions',
] as const;

export const BUILTIN_IDENTIFIERS = [
  ...MARKER_IDENTIFIERS,
  ...EDITABLE_BUILTIN_IDENTIFIERS,
] as const;

/** The two prompts a character card may override via system_prompt / post_history_instructions. */
export const OVERRIDABLE_IDENTIFIERS = ['main', 'jailbreak'] as const;

export function isMarkerIdentifier(identifier: string): boolean {
  return (MARKER_IDENTIFIERS as readonly string[]).includes(identifier);
}

export function isBuiltinIdentifier(identifier: string): boolean {
  return (BUILTIN_IDENTIFIERS as readonly string[]).includes(identifier);
}
