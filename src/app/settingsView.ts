/**
 * App settings as the shell reads them: every default filled in, and every model slot
 * resolved to something a feature can run on or a reason it cannot.
 *
 * Pure, so the one place a missing field turns into its default is testable, and so every
 * shell — today's and the 3.0 one — reads the same answers. `useAppSettings` memoises it on
 * the settings object, which keeps array identities stable between settings writes.
 */

import { DEFAULT_SINGLE_COMPOSER_LAYOUT } from '@shared/composer/layout.ts';
import {
  type ChatReasoningEfforts,
  type CoCreatorReasoningEfforts,
  emptyCoCreatorReasoningEfforts,
} from '@shared/models/reasoning.ts';
import {
  DEFAULT_MODEL_SLOTS,
  type ModelResolution,
  type ModelSlots,
  resolveSlot,
} from '@shared/models/slots.ts';
import { DEFAULT_NEXUS, type NexusSettings } from '@shared/nexus/types.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import { type ArenaSettings, DEFAULT_ARENA } from '@shared/types/arena.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import {
  type AppSettings,
  type CoCreatorSettings,
  DEFAULT_COCREATOR,
  DEFAULT_DIALOGUE_COLORS,
  DEFAULT_GUIDANCE,
  DEFAULT_SUMMARY,
  type DialogueColorSettings,
  type GuidanceSettings,
  type MemoryMode,
  type QuickCommand,
  type SummarySettings,
} from '@shared/types/settings.ts';
import { DEFAULT_WI_SETTINGS, type WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { EffectId } from '../features/backgrounds/effects.ts';
import { resolveBackgroundEffect } from '../features/backgrounds/resolve.ts';
import { resolveBackgroundUrl } from '../features/settings/backgrounds.ts';

/** A slot resolved for a feature: the model to run on, or why there is none. */
export interface SlotModel {
  model: ResolvedModel | null;
  blockedReason: string | null;
}

function slotModel(resolution: ModelResolution | null): SlotModel {
  if (!resolution) return { model: null, blockedReason: null };
  return resolution.ok
    ? { model: resolution.model, blockedReason: null }
    : { model: null, blockedReason: resolution.reason };
}

export interface AppModels {
  slots: ModelSlots;
  chat: SlotModel;
  summary: SlotModel;
  nexus: SlotModel;
}

/** Every app-wide slot the shell runs a feature on. Null settings (still loading) block none. */
export function resolveAppModels(settings: AppSettings | null): AppModels {
  const resolve = (slot: 'chat' | 'summary' | 'nexus') =>
    slotModel(settings ? resolveSlot(settings, slot) : null);
  const nexus = resolve('nexus');
  return {
    slots: settings?.models ?? DEFAULT_MODEL_SLOTS,
    chat: resolve('chat'),
    summary: resolve('summary'),
    // Nexus parses a JSON contract; reasoning text would only be noise in it.
    nexus: nexus.model ? { ...nexus, model: { ...nexus.model, showReasoning: false } } : nexus,
  };
}

/** What every screen paints behind itself. */
export interface Backdrop {
  url: string | null;
  blur: number;
  dim: number;
  effect: EffectId | null;
  effectLayer: 'behind' | 'front';
}

export interface SettingsView {
  backdrop: Backdrop;
  chatReasoningEfforts: ChatReasoningEfforts;
  coCreatorReasoningEfforts: CoCreatorReasoningEfforts;
  summary: SummarySettings;
  nexus: NexusSettings;
  memoryMode: MemoryMode;
  coCreator: CoCreatorSettings;
  arena: ArenaSettings;
  worldInfo: WorldInfoSettings;
  guidance: GuidanceSettings;
  dialogueColors: DialogueColorSettings;
  characterRatings: Record<string, number>;
  characterCrops: Record<string, number>;
  characterListSort: 'name' | 'rating';
  hiddenTags: string[];
  quickCommands: QuickCommand[];
  /** Only the enabled ones: a disabled script is inert, so nothing need walk past it. */
  regexScripts: RegexScript[];
  collapsedCharacterFolders: string[];
  collapsedChatMenuGroups: string[];
  /** Books the user made global. Opt-in per book: nothing is global until chosen. */
  globalBookIds: string[];
  studioInspectorCollapsed: boolean;
  composerLayout: AppSettings['composerLayouts']['single'];
  streamingFps: number;
  revealReplies: 'written' | 'finished';
}

const EMPTY_COCREATOR_REASONING_EFFORTS: CoCreatorReasoningEfforts =
  emptyCoCreatorReasoningEfforts();

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * Settings with every default filled in. The server normalises what it stores, so most
 * fallbacks only cover the render before settings have loaded.
 */
export function appSettingsView(settings: AppSettings | null): SettingsView {
  return {
    backdrop: {
      url: resolveBackgroundUrl(settings?.background),
      blur: Number(settings?.backgroundBlur ?? 8),
      dim: Number(settings?.backgroundDim ?? 0.55),
      // The one resolve point for the ambient-effect layer — every shell gets the same
      // answer, so pairing, master switch and unknown-id degrade cannot disagree by surface.
      effect: resolveBackgroundEffect(settings ?? {}),
      effectLayer: settings?.backgroundEffectLayer === 'front' ? 'front' : 'behind',
    },
    chatReasoningEfforts: settings?.chatReasoningEfforts ?? {},
    coCreatorReasoningEfforts:
      settings?.coCreatorReasoningEfforts ?? EMPTY_COCREATOR_REASONING_EFFORTS,
    summary: settings?.summary ?? DEFAULT_SUMMARY,
    nexus: settings?.nexus ?? DEFAULT_NEXUS,
    memoryMode: settings?.memoryMode ?? 'classic',
    coCreator: settings?.coCreator ?? DEFAULT_COCREATOR,
    arena: settings?.arena ?? DEFAULT_ARENA,
    worldInfo: settings?.worldInfo ?? DEFAULT_WI_SETTINGS,
    guidance: settings?.guidance ?? DEFAULT_GUIDANCE,
    dialogueColors: settings?.dialogueColors ?? DEFAULT_DIALOGUE_COLORS,
    characterRatings: settings?.characterRatings ?? {},
    characterCrops: settings?.characterCrops ?? {},
    characterListSort: settings?.characterListSort === 'rating' ? 'rating' : 'name',
    hiddenTags: strings(settings?.hiddenTags),
    quickCommands: settings?.quickCommands ?? [],
    regexScripts: (settings?.regexScripts ?? []).filter((script) => !script.disabled),
    collapsedCharacterFolders: strings(settings?.collapsedCharacterFolders),
    collapsedChatMenuGroups: strings(settings?.collapsedChatMenuGroups),
    globalBookIds: strings(settings?.globalLorebooks),
    studioInspectorCollapsed: settings?.studioInspectorCollapsed === true,
    composerLayout: settings?.composerLayouts.single ?? DEFAULT_SINGLE_COMPOSER_LAYOUT,
    streamingFps: Number(settings?.streamingFps ?? 30),
    revealReplies: settings?.revealReplies === 'finished' ? 'finished' : 'written',
  };
}
