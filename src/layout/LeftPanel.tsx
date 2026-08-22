import type { MemoryRecall } from '@shared/memory/source.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { MacroWarning } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { SettingsResponse } from '@shared/types/settings.ts';
import type { ActivationResult } from '@shared/worldinfo/activate.ts';
import { useState } from 'react';
import { InspectPanel } from '../features/chat/InspectPanel.tsx';
import type { PromptInspection } from '../features/chat/state/chatReducer.ts';
import { ConnectionPanel } from '../features/connection/ConnectionPanel.tsx';
import { GenerationPanel } from '../features/preset/GenerationPanel.tsx';
import { PresetToolbar } from '../features/preset/PresetToolbar.tsx';
import { PromptsPanel } from '../features/preset/PromptsPanel.tsx';
import { UnsavedBar } from '../features/preset/UnsavedBar.tsx';
import type { PresetDraft } from '../features/preset/usePresetDraft.ts';
import { Panel } from './AppShell.tsx';
import { LEFT_PANELS, type LeftPanelId } from './panels.tsx';

interface LeftPanelProps {
  active: LeftPanelId | null;
  settings: SettingsResponse | null;
  onSettingsChange: (settings: SettingsResponse) => void;
  presets: PresetSummary[];
  presetId: string | null;
  preset: Preset | null;
  onSelectPreset: (id: string) => void;
  draft: PresetDraft;
  tokenCounts?: Record<string, number>;
  macroWarnings?: MacroWarning[];
  extraSamplersSent: boolean;
  /** The active connection, for the Generation panel's provider-behaviour toggles. */
  connection: Connection | null;
  onConnectionPatch: (patch: Partial<Connection>) => void;
  worldInfo: ActivationResult | null;
  memoryRecall: MemoryRecall | null;
  inspection: PromptInspection | null;
}

/**
 * Routes the left side.
 *
 * Always mounted, even when the side is closed — which is what lets `selectedPrompt` live
 * here rather than inside PromptsPanel. Switching to Generation and back should not lose
 * your place in a long prompt editor.
 *
 * The preset chrome (toolbar and unsaved bar) sits outside the scrolling body, so it is
 * present regardless of which panel is showing. See UnsavedBar for why that matters.
 */
export function LeftPanel({
  active,
  settings,
  onSettingsChange,
  presets,
  presetId,
  preset,
  onSelectPreset,
  draft,
  tokenCounts,
  macroWarnings,
  extraSamplersSent,
  connection,
  onConnectionPatch,
  worldInfo,
  memoryRecall,
  inspection,
}: LeftPanelProps) {
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);

  const title = LEFT_PANELS.find((p) => p.id === active)?.label;
  const editsPreset = active === 'prompts' || active === 'generation';

  const chrome = (
    <>
      {editsPreset ? (
        <PresetToolbar
          presets={presets}
          presetId={presetId}
          onSelectPreset={onSelectPreset}
          draft={draft}
        />
      ) : null}
      <UnsavedBar draft={draft} />
    </>
  );

  return (
    <Panel title={title} chrome={chrome}>
      {active === 'connection' ? (
        <ConnectionPanel settings={settings} onChange={onSettingsChange} />
      ) : null}

      {active === 'prompts' ? (
        preset ? (
          <PromptsPanel
            preset={preset}
            draft={draft}
            selected={selectedPrompt}
            onSelect={setSelectedPrompt}
            tokenCounts={tokenCounts}
            macroWarnings={macroWarnings}
          />
        ) : (
          <div className="wc-empty">Loading presets…</div>
        )
      ) : null}

      {active === 'generation' ? (
        preset ? (
          <GenerationPanel
            preset={preset}
            draft={draft}
            extraSamplersSent={extraSamplersSent}
            connection={connection}
            onConnectionPatch={onConnectionPatch}
          />
        ) : (
          <div className="wc-empty">Loading presets…</div>
        )
      ) : null}

      {active === 'inspect' ? (
        <InspectPanel worldInfo={worldInfo} memoryRecall={memoryRecall} inspection={inspection} />
      ) : null}
    </Panel>
  );
}
