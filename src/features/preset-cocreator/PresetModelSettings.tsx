import { COCREATOR_CONTEXT_TOKENS } from '@shared/cocreator/generation.ts';
import type { PresetCocreatorModelSettings } from '@shared/types/preset-cocreator.ts';
import { useEffect, useMemo } from 'react';
import { NumberField, SelectField } from '../../components/Field.tsx';
import { ModelPicker } from '../models/ModelPicker.tsx';
import { useModels } from '../models/ModelsContext.tsx';

interface PresetModelSettingsProps {
  label: string;
  value: PresetCocreatorModelSettings;
  onChange: (value: PresetCocreatorModelSettings) => void;
  requireTools?: boolean;
  onCapabilityChange?: (supported: boolean | null) => void;
}

export function PresetModelSettings({
  label,
  value,
  onChange,
  requireTools = false,
  onCapabilityChange,
}: PresetModelSettingsProps) {
  const { catalogs, loadCatalogs } = useModels();
  const catalog = value.model ? catalogs[value.model.connectionId] : undefined;

  // The tool-capability note reads the catalogue whether or not the picker was opened.
  useEffect(() => {
    if (requireTools) loadCatalogs();
  }, [requireTools, loadCatalogs]);

  const capability = useMemo(() => {
    if (!value.model || catalog?.status !== 'ready') return null;
    const listed = catalog.models.find((entry) => entry.id === value.model?.modelId);
    if (!listed?.supportedParameters) return null;
    return listed.supportedParameters.includes('tools');
  }, [catalog, value.model]);

  useEffect(() => onCapabilityChange?.(capability), [capability, onCapabilityChange]);

  return (
    <div className="preset-cc-model">
      <h3>{label}</h3>
      <div className="field">
        <span className="wc-label">Model</span>
        <ModelPicker
          label={label}
          value={value.model}
          onChange={(model) => onChange({ ...value, model })}
        />
      </div>
      {requireTools ? (
        <p
          className="preset-cc-model__capability"
          data-state={
            capability === false ? 'unsupported' : capability === true ? 'supported' : 'unknown'
          }
        >
          {capability === true
            ? 'Native tool calling is listed for this model.'
            : capability === false
              ? 'This provider lists the model without native tool support.'
              : 'Tool capability is unknown. The model remains selectable; a rejected tool request will be shown here.'}
        </p>
      ) : null}
      {requireTools && catalog?.status === 'error' ? (
        <p className="wc-hint">Model catalogue: {catalog.error}</p>
      ) : null}
      {requireTools ? (
        <div className="preset-cc-model__generation">
          <NumberField
            label="Context size"
            value={value.contextTokens ?? COCREATOR_CONTEXT_TOKENS}
            min={1024}
            max={2097152}
            hint="Set this to the model’s context size. Includes conversation, tools, reasoning and reply."
            onChange={(contextTokens) =>
              onChange({ ...value, contextTokens: Math.round(contextTokens) })
            }
          />
          <NumberField
            label="Temperature"
            value={value.temperature}
            min={0}
            max={2}
            step={0.1}
            onChange={(temperature) => onChange({ ...value, temperature })}
          />
          <SelectField<PresetCocreatorModelSettings['reasoningEffort']>
            label="Reasoning effort"
            value={value.reasoningEffort}
            options={['auto', 'min', 'low', 'medium', 'high', 'max'].map((effort) => ({
              label: effort[0]!.toUpperCase() + effort.slice(1),
              value: effort as PresetCocreatorModelSettings['reasoningEffort'],
            }))}
            onChange={(reasoningEffort) => onChange({ ...value, reasoningEffort })}
          />
        </div>
      ) : null}
    </div>
  );
}
