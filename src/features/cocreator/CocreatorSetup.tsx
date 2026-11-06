import { COCREATOR_CONTEXT_TOKENS } from '@shared/cocreator/generation.ts';
import { type ModelRef, type ModelSlot, type ModelSlots, slotRef } from '@shared/models/slots.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import {
  type CoCreatorSettings,
  DEFAULT_COCREATOR_ANALYSIS_PROMPT,
  DEFAULT_COCREATOR_PROMPT,
} from '@shared/types/settings.ts';
import { useEffect, useMemo, useState } from 'react';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Popover } from '../../components/Popover.tsx';
import { GearIcon } from '../../layout/icons.tsx';
import { ModelPicker } from '../models/ModelPicker.tsx';
import type { UseCocreator } from './useCocreator.ts';
import './CocreatorSetup.css';

type Mode = 'session' | 'defaults';
type SessionPresetChoice = 'default' | 'active' | string;

interface CocreatorSetupProps {
  design: UseCocreator;
  defaults: CoCreatorSettings;
  /** The app's model slots: the defaults tab edits `cocreator`. */
  models: ModelSlots;
  onModelSlotChange: (slot: ModelSlot, ref: ModelRef | null) => void;
  presets: PresetSummary[];
  activePresetId: string | null;
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
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
  models,
  onModelSlotChange,
  presets,
  activePresetId,
  onDefaultsChange,
  open,
  onOpenChange,
  mode,
  onModeChange,
}: CocreatorSetupProps) {
  const settings = design.state.settings;
  const disabled = design.busy;

  const presetChoice: SessionPresetChoice =
    settings.presetId === undefined
      ? 'default'
      : settings.presetId === null
        ? 'active'
        : settings.presetId;

  const label = useMemo(
    () =>
      design.connection ? `${design.connection.model} · ${design.connection.name}` : 'No model',
    [design.connection],
  );

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
            <div className="field">
              <span className="wc-label">Default model</span>
              <ModelPicker
                label="Default Co-Creator model"
                value={models.cocreator}
                onChange={(ref) => onModelSlotChange('cocreator', ref)}
                emptyLabel="Same as chat"
                emptyFollows={models.chat}
                disabled={disabled}
                disabledReason="Stop the current reply before changing its setup."
              />
            </div>
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
            <div className="field">
              <span className="wc-label">Model</span>
              <ModelPicker
                label="Model for this session"
                value={settings.model}
                onChange={(ref) =>
                  design.dispatch({ type: 'settings/patch', patch: { model: ref ?? undefined } })
                }
                emptyLabel="Use Co-Creator default"
                emptyFollows={slotRef(models, 'cocreator')}
                disabled={disabled}
                disabledReason="Stop the current reply before changing its setup."
              />
            </div>

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

            <NumberField
              label="Context size"
              value={settings.contextTokens ?? COCREATOR_CONTEXT_TOKENS}
              min={1024}
              max={2097152}
              disabled={disabled}
              hint="Set this to the selected model’s context size. Includes the conversation, examples, reasoning and reply."
              onChange={(value) =>
                design.dispatch({
                  type: 'settings/patch',
                  patch: { contextTokens: Math.round(value) },
                })
              }
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
