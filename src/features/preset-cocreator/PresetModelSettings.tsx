import type { Connection, ProviderModel } from '@shared/providers/types.ts';
import type { PresetCocreatorModelSettings } from '@shared/types/preset-cocreator.ts';
import { useEffect, useMemo, useState } from 'react';
import { NumberField, SelectField } from '../../components/Field.tsx';
import { settingsApi } from '../../lib/api.ts';
import { ModelCombobox } from '../connection/ModelCombobox.tsx';

interface PresetModelSettingsProps {
  label: string;
  value: PresetCocreatorModelSettings;
  connections: readonly Connection[];
  onChange: (value: PresetCocreatorModelSettings) => void;
  requireTools?: boolean;
  onCapabilityChange?: (supported: boolean | null) => void;
}

export function PresetModelSettings({
  label,
  value,
  connections,
  onChange,
  requireTools = false,
  onCapabilityChange,
}: PresetModelSettingsProps) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelError, setModelError] = useState('');
  const selected = connections.find((connection) => connection.id === value.connectionId) ?? null;

  useEffect(() => {
    if (!selected) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModelError('');
    void settingsApi
      .models(selected.id)
      .then((result) => {
        if (!cancelled) setModels(result.models);
      })
      .catch((failure) => {
        if (!cancelled) {
          setModels([]);
          setModelError((failure as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const capability = useMemo(() => {
    const id = value.model.trim() || selected?.model || '';
    const model = models.find((entry) => entry.id === id);
    if (!model?.supportedParameters) return null;
    return model.supportedParameters.includes('tools');
  }, [models, selected?.model, value.model]);

  useEffect(() => onCapabilityChange?.(capability), [capability, onCapabilityChange]);

  return (
    <div className="preset-cc-model">
      <h3>{label}</h3>
      <label className="field">
        <span className="wc-label">Connection</span>
        <select
          className="wc-select"
          value={value.connectionId ?? ''}
          onChange={(event) => {
            const connection = connections.find((entry) => entry.id === event.target.value);
            onChange({
              ...value,
              connectionId: connection?.id ?? null,
              model: connection?.model ?? '',
            });
          }}
        >
          <option value="">Choose a connection</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="wc-label">Model</span>
        <ModelCombobox
          models={models}
          value={value.model}
          disabled={!selected}
          disabledReason="Choose a connection first."
          onCommit={(model) => onChange({ ...value, model })}
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
      {modelError ? <p className="wc-hint">Model catalogue: {modelError}</p> : null}
      {requireTools ? (
        <div className="preset-cc-model__generation">
          <NumberField
            label="Max tokens"
            value={value.maxTokens}
            min={1}
            max={131072}
            onChange={(maxTokens) => onChange({ ...value, maxTokens: Math.round(maxTokens) })}
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
