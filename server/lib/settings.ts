/**
 * Application settings.
 *
 * These are ours and deliberately not portable — a preset carries prompts and samplers,
 * this file carries which server you are talking to. Keeping them apart means importing
 * someone else's preset cannot silently repoint your endpoint, and exporting yours cannot
 * leak it.
 *
 * A preset's own connection keys (custom_url, openrouter_model, chat_completion_source)
 * still round-trip untouched via the Preset index signature; they are simply never read.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ConnectionSettings } from '../../shared/providers/types.ts';
import { DEFAULT_CONNECTION, PROVIDERS, isProviderId } from '../../shared/providers/types.ts';
import type { AppSettings } from '../../shared/types/settings.ts';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.ts';
import { PATHS } from './paths.ts';

export type { AppSettings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Coerce a stored connection into a valid one, falling back field by field. */
function normalizeConnection(value: unknown): ConnectionSettings {
  if (!isRecord(value)) return { ...DEFAULT_CONNECTION };

  const provider = isProviderId(value.provider) ? value.provider : DEFAULT_CONNECTION.provider;
  const baseUrl =
    typeof value.baseUrl === 'string' && value.baseUrl.trim()
      ? value.baseUrl.trim()
      : PROVIDERS[provider].defaultBaseUrl;

  const connection: ConnectionSettings = {
    provider,
    baseUrl,
    model: typeof value.model === 'string' ? value.model : '',
    showReasoning: value.showReasoning !== false,
  };

  if (isRecord(value.routing)) connection.routing = value.routing as ConnectionSettings['routing'];
  if (isRecord(value.headers)) connection.headers = value.headers as Record<string, string>;
  if (value.reportUsage === true) connection.reportUsage = true;

  return connection;
}

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;

  let stored: Record<string, unknown> = {};
  if (existsSync(PATHS.settings)) {
    try {
      const parsed = JSON.parse(readFileSync(PATHS.settings, 'utf8')) as unknown;
      if (isRecord(parsed)) stored = parsed;
    } catch {
      console.error('[wackchatter] settings.json is unreadable — using defaults.');
    }
  }

  cache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    connection: normalizeConnection(stored.connection),
  };

  return cache;
}

/** Merge a partial update and persist. `connection` merges field-wise. */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings();

  const next: AppSettings = {
    ...current,
    ...patch,
    connection: patch.connection
      ? normalizeConnection({ ...current.connection, ...patch.connection })
      : current.connection,
  };

  writeFileSync(PATHS.settings, `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
  return next;
}

/** Drop the memoized copy. Used by tests. */
export function resetSettingsCache(): void {
  cache = null;
}
