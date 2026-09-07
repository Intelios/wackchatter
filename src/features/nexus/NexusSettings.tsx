import type { NexusSettings as Settings } from '@shared/nexus/types.ts';
import type { Connection, ProviderModel } from '@shared/providers/types.ts';
import { useEffect, useState } from 'react';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { StoryMemoryPlacementFields } from '../../components/StoryMemoryPlacementFields.tsx';
import { settingsApi } from '../../lib/api.ts';
import { ModelCombobox } from '../connection/ModelCombobox.tsx';

export interface NexusSettingsProps {
  settings: Settings;
  connections: Connection[];
  onSettingsChange: (patch: Partial<Settings>) => void;
}
export function NexusSettings({
  settings,
  connections,
  onSettingsChange: patch,
}: NexusSettingsProps) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState(settings.extractPrompt);
  const [template, setTemplate] = useState(settings.template);
  useEffect(() => setPrompt(settings.extractPrompt), [settings.extractPrompt]);
  useEffect(() => setTemplate(settings.template), [settings.template]);
  const connection = connections.find((c) => c.id === settings.connectionId);
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setError('');
    if (connection)
      void settingsApi
        .models(connection.id)
        .then((r) => {
          if (!cancelled) setModels(r.models);
        })
        .catch((e) => {
          if (!cancelled)
            setError(`Catalogue unavailable: ${e.message}. You can enter a model ID.`);
        });
    return () => {
      cancelled = true;
    };
  }, [connection]);
  return (
    <div className="nexus-settings">
      <p>
        Nexus uses its own model for collection and deeper recall. Local search runs on this
        computer.
      </p>
      <SelectField<string | null>
        label="Saved connection"
        value={settings.connectionId}
        options={[
          {
            label:
              settings.connectionId && !connection
                ? 'Connection missing — choose another'
                : 'Choose a connection',
            value: null,
          },
          ...connections.map((c) => ({ label: c.name, value: c.id })),
        ]}
        onChange={(connectionId) => patch({ connectionId })}
      />
      <div>
        <span className="nexus-field-label">Nexus model</span>
        <ModelCombobox
          models={models}
          value={settings.model}
          onCommit={(model) => patch({ model })}
          disabled={!connection}
          disabledReason="Choose a saved connection first."
        />
      </div>
      {!connection || !settings.model ? (
        <p role="status">
          Paid Nexus operations are paused until a connection and model are selected.
        </p>
      ) : null}
      {error ? <p role="status">{error}</p> : null}
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
        max={131072}
        step={1024}
        onChange={(inputTokens) => patch({ inputTokens })}
      />
      <NumberField
        label="Memory model output (tokens)"
        value={settings.outputTokens}
        min={256}
        max={16384}
        step={256}
        onChange={(outputTokens) => patch({ outputTokens })}
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
