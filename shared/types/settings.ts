/**
 * Application settings.
 *
 * Ours, and deliberately not portable: a preset carries prompts and samplers, this
 * carries which server you are talking to. Keeping them apart means importing someone
 * else's preset cannot silently repoint your endpoint, and exporting yours cannot leak it.
 */

import type { Connection } from '../providers/types.ts';
import { DEFAULT_CONNECTION, PROVIDERS } from '../providers/types.ts';
import type { MacroVariableMap } from './chat.ts';
import type { WorldInfoSettings } from './worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from './worldinfo.ts';

export interface AppSettings {
  /**
   * Every saved connection. Generations use `activeConnection` — `connectionId` with a
   * fallback to the first entry — so a stale or cleared selection never strands the app.
   */
  connections: Connection[];
  /** The connection generations use. Null means "the first one". */
  connectionId: string | null;
  /** UI refresh rate during streaming. */
  streamingFps: number;
  /**
   * The persona new chats start with. NOT necessarily the one a given chat uses —
   * `ChatMetadata.persona` wins there, because a transcript records who you were when
   * you wrote it.
   */
  personaId: string | null;
  /** SillyTavern-compatible variables shared by every chat. */
  variables: MacroVariableMap;
  /** Global World Info scan settings. ST stores these per-app too, not per-book. */
  worldInfo: WorldInfoSettings;
  /** Force a tokenizer encoding instead of inferring it from the model id. */
  tokenizerEncoding: 'auto' | 'o200k_base' | 'cl100k_base';
  /** The preset selected on startup. Null means "first alphabetically". */
  presetId: string | null;
  /**
   * Appearance. Flat scalars rather than a nested `appearance` object, because
   * `mergeSettings` only merges `connection`/`worldInfo`/`variables` field-wise — a
   * nested object would need a fourth branch, or patching one key would wipe the rest.
   *
   * `background` is `builtin:<id>` for a bundled asset, `user:<filename>` for an upload,
   * or null for none. The prefix keeps the two namespaces from colliding and lets a
   * deleted upload degrade to "no background" rather than a broken image.
   */
  background: string | null;
  /** Blur applied to the background image, in px. Kills the detail that ruins legibility. */
  backgroundBlur: number;
  /** Scrim opacity over the background, 0–1. The contrast floor. */
  backgroundDim: number;
  /** Translucent panels and bubbles. Only meaningful with a background set. */
  glass: boolean;
  /** Guided Generations: how steering text and standing guides reach the prompt. */
  guidance: GuidanceSettings;
  /** Manual rolling chat summaries: generation source and prompt injection preferences. */
  summary: SummarySettings;
  /** Render-only colours for quoted dialogue. Local UI state; never exported with cards. */
  dialogueColors: DialogueColorSettings;
  /** Unrecognised keys survive, so a newer build's settings are not destroyed. */
  [key: string]: unknown;
}

export type DialogueColorOverride = string | null;

export interface DialogueColorSettings {
  /** Master switch. Per-speaker overrides remain editable while this is false. */
  enabled: boolean;
  /** Missing means avatar-derived, a hex string is custom, and null disables that speaker. */
  characters: Record<string, DialogueColorOverride>;
  /** Keyed by stable persona id, with the same missing/custom/null semantics. */
  personas: Record<string, DialogueColorOverride>;
}

export const DEFAULT_DIALOGUE_COLORS: Readonly<DialogueColorSettings> = {
  enabled: true,
  characters: {},
  personas: {},
};

/**
 * Guided Generations settings.
 *
 * App-scoped rather than per chat, unlike the guides themselves: the template and the
 * depths are a preference you tune once, while a guide is about one story.
 *
 * A nested object rather than flat scalars, so `mergeSettings` grew a fourth field-wise
 * branch — see the note on `background` for why the appearance keys went the other way.
 * Five related knobs justify the branch; three unrelated ones did not.
 */
export interface GuidanceSettings {
  /** Wraps the composer text. `{{input}}` is where that text lands. */
  template: string;
  /**
   * Depth for one-shot guidance. 0 puts it after the last message — the last thing the
   * model reads before it writes, which is the entire point of guiding a reply.
   */
  depth: number;
  role: 'system' | 'user' | 'assistant';
  /** Depth and role shared by every persistent guide. */
  guideDepth: number;
  guideRole: 'system' | 'user' | 'assistant';
}

export const DEFAULT_GUIDANCE: Readonly<GuidanceSettings> = {
  template: '[Take the following into special consideration for your next message: {{input}}]',
  depth: 0,
  role: 'system',
  guideDepth: 1,
  guideRole: 'system',
};

export type SummaryPosition = 'none' | 'beforeMain' | 'afterMain' | 'atDepth';

export interface SummarySettings {
  /** Null follows the active chat connection; otherwise names a saved connection. */
  connectionId: string | null;
  prompt: string;
  targetWords: number;
  /** Wraps the current summary. `{{summary}}` is filled without re-scanning its text. */
  template: string;
  position: SummaryPosition;
  depth: number;
  role: 'system' | 'user' | 'assistant';
}

export const DEFAULT_SUMMARY_PROMPT =
  'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.';

export const DEFAULT_SUMMARY: Readonly<SummarySettings> = {
  connectionId: null,
  prompt: DEFAULT_SUMMARY_PROMPT,
  targetWords: 200,
  template: '[Summary: {{summary}}]',
  position: 'afterMain',
  depth: 2,
  role: 'system',
};

/** What the client is told about a stored API key. Never the key itself. */
export interface KeyInfo {
  present: boolean;
  /** Last four characters, for recognising which key is configured. */
  hint: string;
}

/** Keyed by connection id — each connection's key is its own. */
export type SettingsResponse = AppSettings & { keys: Record<string, KeyInfo> };

/**
 * The id of the connection fresh installs start with. Deliberately not a uuid: the
 * default is a known quantity, and a fixed id keeps DEFAULT_SETTINGS deterministic.
 */
export const DEFAULT_CONNECTION_ID = 'default';

/** The connection generations use, or null when none exist. */
export function activeConnection(
  settings: Pick<AppSettings, 'connections' | 'connectionId'>,
): Connection | null {
  return (
    settings.connections.find((connection) => connection.id === settings.connectionId) ??
    settings.connections[0] ??
    null
  );
}

export const DEFAULT_SETTINGS: AppSettings = {
  connections: [{ ...DEFAULT_CONNECTION, id: DEFAULT_CONNECTION_ID, name: PROVIDERS.custom.label }],
  connectionId: DEFAULT_CONNECTION_ID,
  streamingFps: 30,
  personaId: null,
  variables: {},
  worldInfo: { ...DEFAULT_WI_SETTINGS },
  tokenizerEncoding: 'auto',
  presetId: null,
  background: null,
  backgroundBlur: 8,
  backgroundDim: 0.55,
  glass: true,
  guidance: { ...DEFAULT_GUIDANCE },
  summary: { ...DEFAULT_SUMMARY },
  dialogueColors: {
    enabled: DEFAULT_DIALOGUE_COLORS.enabled,
    characters: {},
    personas: {},
  },
};
