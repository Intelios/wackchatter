import { normalizeSideDefaults, resolveSideSettings } from '@shared/cocreator/sideChat.ts';
import type { Connection, ProviderModel } from '@shared/providers/types.ts';
import type { SideChatModelSettings } from '@shared/types/cocreator.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import { useEffect, useState } from 'react';
import { NumberField, SelectField } from '../../components/Field.tsx';
import { Popover } from '../../components/Popover.tsx';
import { GearIcon } from '../../layout/icons.tsx';
import { settingsApi } from '../../lib/api.ts';
import { ModelCombobox } from '../connection/ModelCombobox.tsx';
import { modelPatch } from './settings.ts';
import type { UseCocreator } from './useCocreator.ts';

export function SideChatSetup({
  design,
  defaults,
  connections,
  onDefaultsChange,
}: {
  design: UseCocreator;
  defaults: CoCreatorSettings;
  connections: Connection[];
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'session' | 'defaults'>('defaults');
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelStatus, setModelStatus] = useState('');
  const settings = mode === 'defaults' ? {} : (design.state.sideChat?.settings ?? {});
  const resolved = resolveSideSettings(defaults.sideChat, settings, connections);
  const savedConnection = connections.find((entry) => entry.id === resolved.connection?.id);
  const disabled = design.busy || (mode === 'session' && !design.state.sideChat);
  const choice =
    mode === 'defaults'
      ? defaults.sideChat.connectionId
      : settings.connectionId === undefined
        ? 'default'
        : settings.connectionId;

  useEffect(() => {
    if (!open || !savedConnection?.baseUrl) {
      setModels([]);
      setModelStatus('');
      return;
    }
    let cancelled = false;
    setModels([]);
    setModelStatus('Loading models…');
    void settingsApi
      .models(savedConnection.id)
      .then((result) => {
        if (!cancelled) {
          setModels(result.models);
          setModelStatus('');
        }
      })
      .catch((error) => {
        if (!cancelled) setModelStatus(`${(error as Error).message} You can enter a model id.`);
      });
    return () => {
      cancelled = true;
    };
  }, [open, savedConnection?.id, savedConnection?.baseUrl]);

  const patch = (value: SideChatModelSettings) => {
    if (mode === 'defaults')
      onDefaultsChange({ sideChat: normalizeSideDefaults({ ...defaults.sideChat, ...value }) });
    else design.dispatch({ type: 'side/settings', patch: value });
  };

  return (
    <Popover
      label="Side chat settings"
      icon={<GearIcon />}
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      popupClassName="cocreator-side-setup"
    >
      <div className="cocreator-setup__contents">
        <div className="cocreator-setup__head">
          <h2>Side chat settings</h2>
          <div className="cocreator-setup__tabs" role="tablist" aria-label="Side settings scope">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'session'}
              onClick={() => setMode('session')}
            >
              This session
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'defaults'}
              onClick={() => setMode('defaults')}
            >
              Defaults
            </button>
          </div>
        </div>
        <SelectField<string | null>
          label="Side connection"
          value={choice}
          disabled={disabled}
          options={[
            ...(mode === 'session' ? [{ label: 'Use side-chat defaults', value: 'default' }] : []),
            { label: 'Choose a connection', value: null },
            ...(choice && choice !== 'default' && !connections.some((c) => c.id === choice)
              ? [{ label: `Unavailable connection (${choice})`, value: choice }]
              : []),
            ...connections.map((c) => ({ label: c.name, value: c.id })),
          ]}
          onChange={(id) =>
            patch({ connectionId: id === 'default' ? undefined : id, modelOverride: undefined })
          }
        />
        <div className="field">
          <span className="wc-label">Side model</span>
          <ModelCombobox
            models={models}
            value={resolved.connection?.model ?? ''}
            disabled={disabled || !savedConnection}
            disabledReason={!savedConnection ? 'Choose a side connection first' : undefined}
            onCommit={(model) => {
              if (savedConnection)
                patch({ ...modelPatch(savedConnection, model), connectionId: savedConnection.id });
            }}
          />
          {modelStatus ? <p className="wc-hint">{modelStatus}</p> : null}
        </div>
        <NumberField
          label="Side output tokens"
          value={resolved.outputTokens}
          min={1}
          max={2097152}
          disabled={disabled}
          onChange={(outputTokens) => patch({ outputTokens })}
        />
        <NumberField
          label="Side context tokens"
          value={resolved.contextTokens}
          min={1}
          max={2097152}
          disabled={disabled}
          onChange={(contextTokens) => patch({ contextTokens })}
        />
        {mode === 'session' ? (
          <button
            type="button"
            className="wc-button wc-button--ghost"
            disabled={disabled}
            onClick={() =>
              patch({
                connectionId: undefined,
                modelOverride: undefined,
                outputTokens: undefined,
                contextTokens: undefined,
              })
            }
          >
            Use all side-chat defaults
          </button>
        ) : null}
        <p className="wc-hint">
          Side chat uses the main Co-Creator sampler preset and streaming setting. Its connection
          and model are independent. Full main context still uses input tokens.
        </p>
      </div>
    </Popover>
  );
}
