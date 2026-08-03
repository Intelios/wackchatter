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
import { DEFAULT_CONNECTION, isProviderId, PROVIDERS } from '../../shared/providers/types.ts';
import type {
  AppSettings,
  DialogueColorOverride,
  DialogueColorSettings,
  GuidanceSettings,
} from '../../shared/types/settings.ts';
import {
  DEFAULT_DIALOGUE_COLORS,
  DEFAULT_GUIDANCE,
  DEFAULT_SETTINGS,
} from '../../shared/types/settings.ts';
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

const INJECTION_ROLES = ['system', 'user', 'assistant'] as const;

function normalizeRole(
  value: unknown,
  fallback: GuidanceSettings['role'],
): GuidanceSettings['role'] {
  return INJECTION_ROLES.includes(value as GuidanceSettings['role'])
    ? (value as GuidanceSettings['role'])
    : fallback;
}

/**
 * Coerce stored Guided Generations settings, field by field, like `normalizeWorldInfo`.
 *
 * The roles cannot go through the same typeof comparison the numbers do: both sides are
 * `string`, so any word at all would pass and the bad role would only surface as a 400
 * from the provider, with nothing pointing back at this file.
 */
function normalizeGuidance(value: unknown): GuidanceSettings {
  const stored = isRecord(value) ? value : {};
  const number = (key: 'depth' | 'guideDepth'): number => {
    const candidate = stored[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
      ? candidate
      : DEFAULT_GUIDANCE[key];
  };

  return {
    template: typeof stored.template === 'string' ? stored.template : DEFAULT_GUIDANCE.template,
    depth: number('depth'),
    role: normalizeRole(stored.role, DEFAULT_GUIDANCE.role),
    guideDepth: number('guideDepth'),
    guideRole: normalizeRole(stored.guideRole, DEFAULT_GUIDANCE.guideRole),
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizeDialogueColorMap(value: unknown): Record<string, DialogueColorOverride> {
  if (!isRecord(value)) return {};

  const entries: Array<[string, DialogueColorOverride]> = [];
  for (const [id, candidate] of Object.entries(value)) {
    if (!id) continue;
    if (candidate === null) entries.push([id, null]);
    else if (typeof candidate === 'string' && HEX_COLOR.test(candidate)) {
      entries.push([id, candidate.toLowerCase()]);
    }
  }
  return Object.fromEntries(entries);
}

function normalizeDialogueColors(value: unknown): DialogueColorSettings {
  const stored = isRecord(value) ? value : {};
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_DIALOGUE_COLORS.enabled,
    characters: normalizeDialogueColorMap(stored.characters),
    personas: normalizeDialogueColorMap(stored.personas),
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
    guidance: normalizeGuidance(stored.guidance),
    dialogueColors: normalizeDialogueColors(stored.dialogueColors),
  };

  return cache;
}

/**
 * Apply a partial update. Pure, so the merge rules are testable without a filesystem.
 *
 * `connection`, `worldInfo` and `guidance` merge FIELD-WISE. A shallow spread would drop
 * every field the patch didn't mention, so a client changing only the scan depth would
 * silently reset the budget and every match setting along with it.
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
    guidance: patch.guidance
      ? normalizeGuidance({ ...current.guidance, ...patch.guidance })
      : current.guidance,
    dialogueColors: patch.dialogueColors
      ? normalizeDialogueColors({
          ...current.dialogueColors,
          ...patch.dialogueColors,
          characters:
            patch.dialogueColors.characters === undefined
              ? current.dialogueColors.characters
              : patch.dialogueColors.characters,
          personas:
            patch.dialogueColors.personas === undefined
              ? current.dialogueColors.personas
              : patch.dialogueColors.personas,
        })
      : current.dialogueColors,
  };
}

/** Merge a partial update and persist. */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = mergeSettings(getSettings(), patch);

  atomicWriteSync(PATHS.settings, `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
  return next;
}

/**
 * Drop the memoized copy, so the next read comes from whatever settings.json is current.
 *
 * Used by tests, and by the data-directory move — the cached settings belong to the old
 * root and would otherwise be written back over the new one.
 */
export function resetSettingsCache(): void {
  cache = null;
}

/** Re-key or remove the local dialogue colour attached to a character filename. */
export function reassignCharacterDialogueColor(
  current: AppSettings,
  oldAvatar: string,
  newAvatar: string | null,
): AppSettings | null {
  if (!Object.hasOwn(current.dialogueColors.characters, oldAvatar)) return null;

  const characters = { ...current.dialogueColors.characters };
  const value = characters[oldAvatar]!;
  delete characters[oldAvatar];
  if (newAvatar !== null) characters[newAvatar] = value;
  return { ...current, dialogueColors: { ...current.dialogueColors, characters } };
}

/** Remove local appearance state when a stable persona id is deleted. */
export function removePersonaDialogueColor(
  current: AppSettings,
  personaId: string,
): AppSettings | null {
  if (!Object.hasOwn(current.dialogueColors.personas, personaId)) return null;

  const personas = { ...current.dialogueColors.personas };
  delete personas[personaId];
  return { ...current, dialogueColors: { ...current.dialogueColors, personas } };
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
