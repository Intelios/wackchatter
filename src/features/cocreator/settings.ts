import type { Connection } from '@shared/providers/types.ts';
import type { SessionModelSettings } from '@shared/types/cocreator.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';

export interface ResolvedCocreatorSettings {
  connection: Connection | null;
  presetId: string | null;
  systemPrompt: string;
  analysisPrompt: string;
}

function connectionById(connections: readonly Connection[], id: string | null): Connection | null {
  if (id) return connections.find((entry) => entry.id === id) ?? null;
  return connections[0] ?? null;
}

function validPresetId(presets: readonly PresetSummary[], id: string | null): string | null {
  return id && presets.some((entry) => entry.id === id) ? id : null;
}

/** Resolve the three-state session overrides without mutating app-wide selections. */
export function resolveCocreatorSettings(input: {
  session: SessionModelSettings;
  defaults: CoCreatorSettings;
  connections: readonly Connection[];
  activeConnectionId: string | null;
  presets: readonly PresetSummary[];
  activePresetId: string | null;
}): ResolvedCocreatorSettings {
  const { session, defaults, connections, activeConnectionId, presets, activePresetId } = input;
  const activeConnection = connectionById(connections, activeConnectionId);
  const defaultConnection =
    (defaults.connectionId && connectionById(connections, defaults.connectionId)) ||
    activeConnection;

  let connection: Connection | null;
  if (session.connectionId === undefined) connection = defaultConnection;
  else if (session.connectionId === null) connection = activeConnection;
  else connection = connectionById(connections, session.connectionId) ?? defaultConnection;

  if (
    connection &&
    session.modelOverride?.connectionId === connection.id &&
    session.modelOverride.model.trim()
  ) {
    connection = { ...connection, model: session.modelOverride.model.trim() };
  }

  const activePreset = validPresetId(presets, activePresetId);
  const defaultPreset = validPresetId(presets, defaults.presetId) ?? activePreset;
  const presetId =
    session.presetId === undefined
      ? defaultPreset
      : session.presetId === null
        ? activePreset
        : (validPresetId(presets, session.presetId) ?? defaultPreset);

  return {
    connection,
    presetId,
    systemPrompt: session.systemPrompt?.trim() ? session.systemPrompt : defaults.systemPrompt,
    analysisPrompt: session.analysisPrompt?.trim()
      ? session.analysisPrompt
      : defaults.analysisPrompt,
  };
}

/** A connection switch invalidates a model override made for another endpoint. */
export function connectionPatch(
  connectionId: string | null | undefined,
  current: SessionModelSettings,
): SessionModelSettings {
  const patch: SessionModelSettings = { connectionId };
  if (current.modelOverride) patch.modelOverride = undefined;
  return patch;
}

/** Store only genuine overrides; selecting the saved model means inherit it. */
export function modelPatch(connection: Connection, model: string): SessionModelSettings {
  const trimmed = model.trim();
  return {
    modelOverride:
      !trimmed || trimmed === connection.model
        ? undefined
        : { connectionId: connection.id, model: trimmed },
  };
}
