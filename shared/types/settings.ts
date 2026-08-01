/**
 * Application settings.
 *
 * Ours, and deliberately not portable: a preset carries prompts and samplers, this
 * carries which server you are talking to. Keeping them apart means importing someone
 * else's preset cannot silently repoint your endpoint, and exporting yours cannot leak it.
 */

import type { ConnectionSettings, ProviderId } from '../providers/types.ts';
import { DEFAULT_CONNECTION } from '../providers/types.ts';
import type { WorldInfoSettings } from './worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from './worldinfo.ts';

export interface AppSettings {
  connection: ConnectionSettings;
  /** UI refresh rate during streaming. */
  streamingFps: number;
  /**
   * The persona new chats start with. NOT necessarily the one a given chat uses —
   * `ChatMetadata.persona` wins there, because a transcript records who you were when
   * you wrote it.
   */
  personaId: string | null;
  /** Global World Info scan settings. ST stores these per-app too, not per-book. */
  worldInfo: WorldInfoSettings;
  /** Force a tokenizer encoding instead of inferring it from the model id. */
  tokenizerEncoding: 'auto' | 'o200k_base' | 'cl100k_base';
  /** Unrecognised keys survive, so a newer build's settings are not destroyed. */
  [key: string]: unknown;
}

/** What the client is told about a stored API key. Never the key itself. */
export interface KeyInfo {
  present: boolean;
  /** Last four characters, for recognising which key is configured. */
  hint: string;
}

export type SettingsResponse = AppSettings & { keys: Record<ProviderId, KeyInfo> };

export const DEFAULT_SETTINGS: AppSettings = {
  connection: { ...DEFAULT_CONNECTION },
  streamingFps: 30,
  personaId: null,
  worldInfo: { ...DEFAULT_WI_SETTINGS },
  tokenizerEncoding: 'auto',
};
