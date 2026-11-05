import type { ModelRef } from '@shared/models/slots.ts';
import { NEXUS_PROMPT, type NexusSettings as Settings } from '@shared/nexus/types.ts';
import type { ReasoningEffort } from '@shared/types/preset.ts';
import { useEffect, useState } from 'react';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { StoryMemoryPlacementFields } from '../../components/StoryMemoryPlacementFields.tsx';
import { RefreshIcon } from '../../layout/icons.tsx';
import { ModelPicker } from '../models/ModelPicker.tsx';

export interface NexusSettingsProps {
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  /** The `nexus` slot. It never follows chat: Nexus spends in the background. */
  model: ModelRef | null;
  onModelChange: (ref: ModelRef | null) => void;
  /** Why Nexus cannot run, or null when it can. */
  blockedReason: string | null;
}
export function NexusSettings({
  settings,
  onSettingsChange: patch,
  model,
  onModelChange,
  blockedReason,
}: NexusSettingsProps) {
  const [prompt, setPrompt] = useState(settings.extractPrompt);
  const [template, setTemplate] = useState(settings.template);
  useEffect(() => setPrompt(settings.extractPrompt), [settings.extractPrompt]);
  useEffect(() => setTemplate(settings.template), [settings.template]);
  return (
    <div className="nexus-settings">
      <p>
        Nexus uses its own model for collection and deeper recall. Local search runs on this
        computer.
      </p>
      <div>
        <span className="nexus-field-label">Nexus model</span>
        <ModelPicker label="Nexus model" value={model} onChange={onModelChange} />
      </div>
      {blockedReason ? (
        <p role="status">Paid Nexus operations are paused. {blockedReason}</p>
      ) : null}
      <NumberField
        label="Collect every (new messages)"
        value={settings.autoInterval}
        min={0}
        max={2000}
        step={1}
        onChange={(autoInterval) => patch({ autoInterval })}
        hint="12 by default. 0 turns off automatic collection."
      />
      <NumberField
        label="Recall allowance (tokens)"
        value={settings.budgetTokens}
        min={0}
        max={32000}
        step={100}
        onChange={(budgetTokens) => patch({ budgetTokens })}
        hint="Shared by pins, selected findings, and automatic recall. Separate from lorebooks."
      />
      <NumberField
        label="Memory model context (tokens)"
        value={settings.inputTokens}
        min={2048}
        step={1024}
        onChange={(inputTokens) => patch({ inputTokens })}
        hint="Match the model's real context — modern models take 200K to 1M."
      />
      <NumberField
        label="Memory model output (tokens)"
        value={settings.outputTokens}
        min={256}
        max={16384}
        step={256}
        onChange={(outputTokens) => patch({ outputTokens })}
        hint="Buys only the visible JSON. Reasoning is budgeted separately, on top."
      />
      <SelectField<ReasoningEffort>
        label="Reasoning effort"
        value={settings.reasoningEffort}
        options={[
          { label: 'Auto', value: 'auto' },
          { label: 'Min', value: 'min' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
          { label: 'Max', value: 'max' },
        ]}
        onChange={(reasoningEffort) => patch({ reasoningEffort })}
        hint="Sizes the thinking room bought on top of the output allowance — 4K at Min to 64K at Max. Low by default to keep the bill modest; the JSON keeps its full budget at every setting. Auto sends nothing, for endpoints that reject the parameter."
      />
      <NumberField
        label="Extraction temperature"
        value={settings.temperature}
        min={0}
        max={2}
        step={0.1}
        onChange={(temperature) => patch({ temperature })}
      />
      <TextField
        label="Extraction guidance"
        value={prompt}
        onChange={setPrompt}
        onCommit={() => patch({ extractPrompt: prompt })}
        multiline
        rows={8}
        hint="The sourced JSON response contract is fixed and validated separately."
      />
      <button
        type="button"
        className="wc-button wc-button--ghost nexus-settings__reset"
        disabled={prompt === NEXUS_PROMPT}
        onClick={() => {
          setPrompt(NEXUS_PROMPT);
          patch({ extractPrompt: NEXUS_PROMPT });
        }}
      >
        <RefreshIcon />
        Restore default guidance
      </button>
      <CheckField
        label="Living map motion"
        checked={settings.motion}
        onChange={(motion) => patch({ motion })}
        hint="Your system’s reduced-motion preference takes priority."
      />
      <Section title="Injection" defaultOpen>
        <StoryMemoryPlacementFields
          settings={settings}
          onSettingsChange={patch}
          templateDraft={template}
          onTemplateDraftChange={setTemplate}
          onTemplateCommit={() => patch({ template })}
          macro="memories"
        />
      </Section>
    </div>
  );
}
