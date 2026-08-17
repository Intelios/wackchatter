import type { Connection, ProviderModel } from '@shared/providers/types.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import {
  type CoCreatorSettings,
  DEFAULT_COCREATOR_ANALYSIS_PROMPT,
  DEFAULT_COCREATOR_PROMPT,
} from '@shared/types/settings.ts';
import { useEffect, useMemo, useState } from 'react';
import { CheckField, SelectField, TextField } from '../../components/Field.tsx';
import { Popover } from '../../components/Popover.tsx';
import { GearIcon } from '../../layout/icons.tsx';
import { settingsApi } from '../../lib/api.ts';
import { ModelCombobox } from '../connection/ModelCombobox.tsx';
import { connectionPatch, modelPatch } from './settings.ts';
import type { UseCocreator } from './useCocreator.ts';
import './CocreatorSetup.css';

type Mode = 'session' | 'defaults';
type SessionConnectionChoice = 'default' | 'active' | string;
type SessionPresetChoice = 'default' | 'active' | string;

interface CocreatorSetupProps {
  design: UseCocreator;
  defaults: CoCreatorSettings;
  connections: Connection[];
  activeConnectionId: string | null;
  presets: PresetSummary[];
  activePresetId: string | null;
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
}

function activeConnection(connections: Connection[], id: string | null): Connection | null {
  return (id ? connections.find((entry) => entry.id === id) : null) ?? connections[0] ?? null;
}

function PromptEditor({
  label,
  value,
  builtin,
  allowRestore = true,
  disabled,
  onApply,
}: {
  label: string;
  value: string;
  builtin: string;
  allowRestore?: boolean;
  disabled: boolean;
  onApply: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(value);
    setError('');
  }, [value]);

  const apply = () => {
    if (!draft.trim()) {
      setError('Prompt cannot be blank.');
      return;
    }
    setError('');
    onApply(draft);
  };

  return (
    <div className="cocreator-setup__prompt">
      <TextField
        label={label}
        value={draft}
        onChange={setDraft}
        multiline
        expandable
        rows={7}
        disabled={disabled}
      />
      {error ? <p className="cocreator-setup__error">{error}</p> : null}
      <div className="cocreator-setup__prompt-actions">
        <button
          type="button"
          className="wc-button wc-button--primary"
          disabled={disabled || draft === value}
          onClick={apply}
        >
          Apply
        </button>
        {allowRestore ? (
          <button
            type="button"
            className="wc-button wc-button--ghost"
            disabled={disabled || value === builtin}
            onClick={() => {
              setDraft(builtin);
              setError('');
              onApply(builtin);
            }}
          >
            Restore built-in
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function CocreatorSetup({
  design,
  defaults,
  connections,
  activeConnectionId,
  presets,
  activePresetId,
  onDefaultsChange,
  open,
  onOpenChange,
  mode,
  onModeChange,
}: CocreatorSetupProps) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsStatus, setModelsStatus] = useState('');
  const settings = design.state.settings;
  const disabled = design.busy;
  const active = activeConnection(connections, activeConnectionId);

  const modelConnection = design.connection
    ? (connections.find((entry) => entry.id === design.connection?.id) ?? null)
    : null;

  useEffect(() => {
    if (!open || mode !== 'session' || !modelConnection?.baseUrl) {
      setModels([]);
      setModelsStatus('');
      return;
    }
    let cancelled = false;
    setModels([]);
    setModelsStatus('Loading models…');
    void settingsApi
      .models(modelConnection.id)
      .then((result) => {
        if (!cancelled) {
          setModels(result.models);
          setModelsStatus('');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setModels([]);
          setModelsStatus(`${(error as Error).message} You can still enter a model id.`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, modelConnection?.id, modelConnection?.baseUrl]);

  const connectionChoice: SessionConnectionChoice =
    settings.connectionId === undefined
      ? 'default'
      : settings.connectionId === null
        ? 'active'
        : settings.connectionId;
  const presetChoice: SessionPresetChoice =
    settings.presetId === undefined
      ? 'default'
      : settings.presetId === null
        ? 'active'
        : settings.presetId;

  const label = useMemo(() => {
    const name = design.connection?.name ?? 'No connection';
    const model = design.connection?.model || 'no model';
    return `${name} · ${model}`;
  }, [design.connection]);

  return (
    <Popover
      label="Co-Creator setup"
      icon={<GearIcon />}
      open={open}
      onOpenChange={onOpenChange}
      className="cocreator-setup-anchor"
      popupClassName={`cocreator-setup cocreator-setup--${mode}`}
      placement="bottom-end"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          className="wc-button wc-button--ghost cocreator-setup__trigger"
          onClick={() => onOpenChange(!open)}
        >
          <GearIcon />
          <span>{label}</span>
        </button>
      )}
    >
      <div className="cocreator-setup__contents" onPointerDown={(event) => event.stopPropagation()}>
        <div className="cocreator-setup__head">
          <h2>Co-Creator setup</h2>
          <div className="cocreator-setup__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'session'}
              onClick={() => onModeChange('session')}
            >
              This session
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'defaults'}
              onClick={() => onModeChange('defaults')}
            >
              Defaults
            </button>
          </div>
        </div>

        {mode === 'defaults' ? (
          <div className="cocreator-setup__body cocreator-setup__body--defaults">
            <SelectField<string | null>
              label="Default connection"
              value={defaults.connectionId}
              options={[
                {
                  label: active
                    ? `Follow active connection (${active.name})`
                    : 'Follow active connection',
                  value: null,
                },
                ...connections.map((entry) => ({ label: entry.name, value: entry.id })),
              ]}
              onChange={(connectionId) => onDefaultsChange({ connectionId })}
              disabled={disabled}
            />
            <SelectField<string | null>
              label="Default sampler preset"
              value={defaults.presetId}
              options={[
                {
                  label: activePresetId
                    ? `Follow active preset (${presets.find((p) => p.id === activePresetId)?.name ?? activePresetId})`
                    : 'Follow active preset',
                  value: null,
                },
                ...presets.map((entry) => ({ label: entry.name, value: entry.id })),
              ]}
              onChange={(presetId) => onDefaultsChange({ presetId })}
              disabled={disabled}
            />
            <CheckField
              label="Stream replies"
              checked={defaults.streaming}
              onChange={(streaming) => onDefaultsChange({ streaming })}
              hint="Co-Creator only. Chat streaming follows the preset's own setting."
              disabled={disabled}
            />
            <PromptEditor
              label="General system prompt"
              value={defaults.systemPrompt}
              builtin={DEFAULT_COCREATOR_PROMPT}
              disabled={disabled}
              onApply={(systemPrompt) => onDefaultsChange({ systemPrompt })}
            />
            <PromptEditor
              label="Example-analysis prompt"
              value={defaults.analysisPrompt}
              builtin={DEFAULT_COCREATOR_ANALYSIS_PROMPT}
              disabled={disabled}
              onApply={(analysisPrompt) => onDefaultsChange({ analysisPrompt })}
            />
          </div>
        ) : (
          <div className="cocreator-setup__body cocreator-setup__body--session">
            <SelectField<SessionConnectionChoice>
              label="Connection"
              value={connectionChoice}
              options={[
                { label: 'Use Co-Creator default', value: 'default' },
                {
                  label: active
                    ? `Follow active connection (${active.name})`
                    : 'Follow active connection',
                  value: 'active',
                },
                ...connections.map((entry) => ({ label: entry.name, value: entry.id })),
              ]}
              onChange={(choice) =>
                design.dispatch({
                  type: 'settings/patch',
                  patch: connectionPatch(
                    choice === 'default' ? undefined : choice === 'active' ? null : choice,
                    settings,
                  ),
                })
              }
              disabled={disabled}
            />

            {modelConnection ? (
              <div className="field">
                <span className="wc-label">Model</span>
                <ModelCombobox
                  models={models}
                  value={design.connection?.model ?? ''}
                  onCommit={(model) =>
                    design.dispatch({
                      type: 'settings/patch',
                      patch: modelPatch(modelConnection, model),
                    })
                  }
                  disabled={disabled}
                  disabledReason="Stop the current reply before changing its setup."
                />
                <p className="wc-hint">
                  {modelsStatus ||
                    `Connection default: ${modelConnection.model || 'none selected'}`}
                </p>
              </div>
            ) : null}

            <SelectField<SessionPresetChoice>
              label="Sampler preset"
              value={presetChoice}
              options={[
                { label: 'Use Co-Creator default', value: 'default' },
                {
                  label: activePresetId
                    ? `Follow active preset (${presets.find((p) => p.id === activePresetId)?.name ?? activePresetId})`
                    : 'Follow active preset',
                  value: 'active',
                },
                ...presets.map((entry) => ({ label: entry.name, value: entry.id })),
              ]}
              onChange={(choice) =>
                design.dispatch({
                  type: 'settings/patch',
                  patch: {
                    presetId:
                      choice === 'default' ? undefined : choice === 'active' ? null : choice,
                  },
                })
              }
              disabled={disabled}
            />

            <label className="cocreator-setup__inherit">
              <input
                type="checkbox"
                checked={settings.systemPrompt === undefined}
                disabled={disabled}
                onChange={(event) =>
                  design.dispatch({
                    type: 'settings/patch',
                    patch: {
                      systemPrompt: event.target.checked ? undefined : defaults.systemPrompt,
                    },
                  })
                }
              />
              Inherit general prompt
            </label>
            {settings.systemPrompt !== undefined ? (
              <PromptEditor
                label="Session system prompt"
                value={settings.systemPrompt}
                builtin={defaults.systemPrompt}
                allowRestore={false}
                disabled={disabled}
                onApply={(systemPrompt) =>
                  design.dispatch({ type: 'settings/patch', patch: { systemPrompt } })
                }
              />
            ) : null}

            <label className="cocreator-setup__inherit">
              <input
                type="checkbox"
                checked={settings.analysisPrompt === undefined}
                disabled={disabled}
                onChange={(event) =>
                  design.dispatch({
                    type: 'settings/patch',
                    patch: {
                      analysisPrompt: event.target.checked ? undefined : defaults.analysisPrompt,
                    },
                  })
                }
              />
              Inherit analysis prompt
            </label>
            {settings.analysisPrompt !== undefined ? (
              <PromptEditor
                label="Session example-analysis prompt"
                value={settings.analysisPrompt}
                builtin={defaults.analysisPrompt}
                allowRestore={false}
                disabled={disabled}
                onApply={(analysisPrompt) =>
                  design.dispatch({ type: 'settings/patch', patch: { analysisPrompt } })
                }
              />
            ) : null}
          </div>
        )}
      </div>
    </Popover>
  );
}
