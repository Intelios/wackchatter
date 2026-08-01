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

import { existsSync, readFileSync } from 'node:fs';
import type { ConnectionSettings } from '../../shared/providers/types.ts';
import { DEFAULT_CONNECTION, PROVIDERS, isProviderId } from '../../shared/providers/types.ts';
import type { AppSettings } from '../../shared/types/settings.ts';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.ts';
import type { WorldInfoSettings } from '../../shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '../../shared/types/worldinfo.ts';
import { atomicWriteSync } from './fs.ts';
import { PATHS } from './paths.ts';

export type { AppSettings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeVariables(value: unknown): AppSettings['variables'] {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || (typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    ),
  );
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

/**
 * Coerce stored World Info settings, field by field.
 *
 * A settings file written before this key existed has no `worldInfo` at all, and a client
 * may legitimately send a single field, so every field falls back to its default
 * independently rather than the object falling back as a whole.
 */
function normalizeWorldInfo(value: unknown): WorldInfoSettings {
  const stored = isRecord(value) ? value : {};
  const pick = <K extends keyof WorldInfoSettings>(key: K): WorldInfoSettings[K] => {
    const candidate = stored[key as string];
    return typeof candidate === typeof DEFAULT_WI_SETTINGS[key]
      ? (candidate as WorldInfoSettings[K])
      : DEFAULT_WI_SETTINGS[key];
  };

  return {
    depth: pick('depth'),
    budget: pick('budget'),
    budgetCap: pick('budgetCap'),
    recursive: pick('recursive'),
    maxRecursionSteps: pick('maxRecursionSteps'),
    caseSensitive: pick('caseSensitive'),
    matchWholeWords: pick('matchWholeWords'),
    minActivations: pick('minActivations'),
  };
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
    worldInfo: normalizeWorldInfo(stored.worldInfo),
    variables: normalizeVariables(stored.variables),
  };

  return cache;
}

/**
 * Apply a partial update. Pure, so the merge rules are testable without a filesystem.
 *
 * `connection` and `worldInfo` merge FIELD-WISE. A shallow spread would drop every field
 * the patch didn't mention, so a client changing only the scan depth would silently reset
 * the budget and every match setting along with it.
 */
export function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...current,
    ...patch,
    connection: patch.connection
      ? normalizeConnection({ ...current.connection, ...patch.connection })
      : current.connection,
    worldInfo: patch.worldInfo
      ? normalizeWorldInfo({ ...current.worldInfo, ...patch.worldInfo })
      : current.worldInfo,
    variables: patch.variables ? normalizeVariables(patch.variables) : current.variables,
  };
}

/** Merge a partial update and persist. */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = mergeSettings(getSettings(), patch);

  atomicWriteSync(PATHS.settings, `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
  return next;
}

/** Drop the memoized copy. Used by tests. */
export function resetSettingsCache(): void {
  cache = null;
}

/**
 * Repoint the global-lorebook selection when a standalone book is renamed or removed.
 *
 * `globalLorebooks` rides the settings index signature rather than a declared field, so it
 * is read defensively: anything that is not an array of strings is left alone. Pure, so the
 * rewrite rule is testable without a filesystem. Returns the updated settings, or null when
 * nothing referenced the old id and there is nothing to persist.
 */
export function reassignGlobalLorebooks(
  current: AppSettings,
  oldId: string,
  newId: string | null,
): AppSettings | null {
  const stored = current.globalLorebooks;
  if (!Array.isArray(stored) || !stored.includes(oldId)) return null;

  const next =
    newId === null
      ? stored.filter((id) => id !== oldId)
      : stored.map((id) => (id === oldId ? newId : id));

  return { ...current, globalLorebooks: next };
}
