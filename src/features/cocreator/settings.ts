import {
  type ModelResolution,
  type ModelSlots,
  resolveModelRef,
  slotRef,
} from '@shared/models/slots.ts';
import type { Connection, ResolvedModel } from '@shared/providers/types.ts';
import type { SessionModelSettings } from '@shared/types/cocreator.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';

export interface ResolvedCocreatorSettings {
  /** The session's own model, else the `cocreator` slot, else (following it) chat's. */
  model: ModelResolution;
  connection: ResolvedModel | null;
  presetId: string | null;
  systemPrompt: string;
  analysisPrompt: string;
  streaming: boolean;
}

function validPresetId(presets: readonly PresetSummary[], id: string | null): string | null {
  return id && presets.some((entry) => entry.id === id) ? id : null;
}

/** Resolve the session's overrides over the app defaults, without changing either. */
export function resolveCocreatorSettings(input: {
  session: SessionModelSettings;
  defaults: CoCreatorSettings;
  connections: readonly Connection[];
  models: ModelSlots;
  presets: readonly PresetSummary[];
  activePresetId: string | null;
}): ResolvedCocreatorSettings {
  const { session, defaults, connections, models, presets, activePresetId } = input;
  const model = resolveModelRef(
    connections,
    session.model ?? slotRef(models, 'cocreator'),
    'Co-Creator',
  );

  const activePreset = validPresetId(presets, activePresetId);
  const defaultPreset = validPresetId(presets, defaults.presetId) ?? activePreset;
  const presetId =
    session.presetId === undefined
      ? defaultPreset
      : session.presetId === null
        ? activePreset
        : (validPresetId(presets, session.presetId) ?? defaultPreset);

  return {
    model,
    connection: model.ok ? model.model : null,
    presetId,
    systemPrompt: session.systemPrompt?.trim() ? session.systemPrompt : defaults.systemPrompt,
    analysisPrompt: session.analysisPrompt?.trim()
      ? session.analysisPrompt
      : defaults.analysisPrompt,
    streaming: defaults.streaming,
  };
}
