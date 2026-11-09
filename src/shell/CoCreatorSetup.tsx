/**
 * The Co-Creator's setup: which models write, with which samplers, and what they are told.
 * For this session, or for every new one. There is no context size: each request is sized
 * from its model's own context.
 */

import type { ModelRef, ModelSlot, ModelSlots } from '@shared/models/slots.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import {
  type CoCreatorSettings,
  DEFAULT_COCREATOR_ANALYSIS_PROMPT,
  DEFAULT_COCREATOR_PROMPT,
} from '@shared/types/settings.ts';
import { useState } from 'react';
import { Popover } from '../components/Popover.tsx';
import { Select } from '../components/Select.tsx';
import type { UseCocreator } from '../features/cocreator/useCocreator.ts';
import { ModelPicker } from '../features/models/ModelPicker.tsx';
import { Segments, Switch } from './controls.tsx';
import { Icon } from './icons.tsx';

type Scope = 'session' | 'defaults';

/** Instructions: written in place, applied on purpose, the built-in a click away. */
function Instructions({
  label,
  value,
  builtin,
  disabled,
  onApply,
}: {
  label: string;
  value: string;
  builtin: string | null;
  disabled: boolean;
  onApply: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [was, setWas] = useState(value);
  if (value !== was) {
    setWas(value);
    setDraft(value);
  }
  return (
    <div className="w3-co-setup__prompt">
      <textarea
        value={draft}
        aria-label={label}
        rows={7}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="w3-co-setup__prompt-acts">
        {builtin !== null ? (
          <button
            type="button"
            className="w3-st-ghost w3-st-ghost--sm"
            disabled={disabled || value === builtin}
            onClick={() => onApply(builtin)}
          >
            Built-in
          </button>
        ) : null}
        <button
          type="button"
          className="w3-st-pill w3-co-pill"
          disabled={disabled || draft === value || !draft.trim()}
          onClick={() => onApply(draft)}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

export function CoCreatorSetup({
  design,
  defaults,
  models,
  presets,
  activePresetId,
  onModelSlotChange,
  onDefaultsChange,
}: {
  design: UseCocreator;
  defaults: CoCreatorSettings;
  models: ModelSlots;
  presets: readonly PresetSummary[];
  activePresetId: string | null;
  onModelSlotChange: (slot: ModelSlot, ref: ModelRef | null) => void;
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('session');
  const [prompt, setPrompt] = useState<'system' | 'analysis' | null>(null);
  const settings = design.state.settings;
  const disabled = design.busy;
  const disabledReason = 'Stop the current reply first.';
  const activeName = presets.find((p) => p.id === activePresetId)?.name;
  const follow = activeName
    ? `Follow the active preset (${activeName})`
    : 'Follow the active preset';
  const presetOptions = presets.map((p) => ({ value: p.id, label: p.name }));
  const sessionPreset =
    settings.presetId === undefined
      ? 'default'
      : settings.presetId === null
        ? 'active'
        : settings.presetId;

  return (
    <Popover
      label="Co-Creator setup"
      icon={null}
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      role="dialog"
      popupClassName="w3-co-setup"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          className="w3-st-topbtn"
          title={
            design.connection
              ? `${design.connection.model} · ${design.connection.name}`
              : 'No model'
          }
          onClick={() => setOpen(!open)}
        >
          <Icon name="gear" size="sm" />
          Setup
        </button>
      )}
    >
      <div className="w3-co-setup__body">
        <Segments
          label="Which sessions"
          value={scope}
          options={[
            ['session', 'This session'],
            ['defaults', 'Every new session'],
          ]}
          onChange={setScope}
        />
        {scope === 'session' ? (
          <>
            <div className="w3-co-setup__field">
              <span>Samplers</span>
              <Select
                label="Sampler preset for this session"
                value={sessionPreset}
                options={[
                  { value: 'default', label: "The Co-Creator's" },
                  { value: 'active', label: follow },
                  ...presetOptions,
                ]}
                disabled={disabled}
                onChange={(choice) =>
                  design.dispatch({
                    type: 'settings/patch',
                    patch: {
                      presetId:
                        choice === 'default' ? undefined : choice === 'active' ? null : choice,
                    },
                  })
                }
              />
            </div>
            <div className="w3-co-setup__row">
              <span>Its own instructions</span>
              <Switch
                label="Give this session its own instructions"
                on={settings.systemPrompt !== undefined}
                disabled={disabled}
                onChange={(on) =>
                  design.dispatch({
                    type: 'settings/patch',
                    patch: { systemPrompt: on ? design.systemPrompt : undefined },
                  })
                }
              />
            </div>
            {settings.systemPrompt !== undefined ? (
              <Instructions
                label="This session's instructions"
                value={settings.systemPrompt}
                builtin={null}
                disabled={disabled}
                onApply={(systemPrompt) =>
                  design.dispatch({ type: 'settings/patch', patch: { systemPrompt } })
                }
              />
            ) : null}
          </>
        ) : (
          <>
            <div className="w3-co-setup__field">
              <span>Model</span>
              <ModelPicker
                label="Co-Creator model"
                value={models.cocreator}
                onChange={(ref) => onModelSlotChange('cocreator', ref)}
                emptyLabel="Same as chat"
                emptyFollows={models.chat}
                disabled={disabled}
                disabledReason={disabledReason}
              />
            </div>
            <div className="w3-co-setup__field">
              <span>Side chat model</span>
              <ModelPicker
                label="Side chat model"
                value={models.sideChat}
                onChange={(ref) => onModelSlotChange('sideChat', ref)}
                disabled={disabled}
                disabledReason={disabledReason}
              />
            </div>
            <div className="w3-co-setup__field">
              <span>Samplers</span>
              <Select
                label="Co-Creator sampler preset"
                value={defaults.presetId}
                options={[{ value: null, label: follow }, ...presetOptions]}
                disabled={disabled}
                onChange={(presetId) => onDefaultsChange({ presetId })}
              />
            </div>
            <div className="w3-co-setup__row">
              <span>Stream replies</span>
              <Switch
                label="Stream replies"
                on={defaults.streaming}
                disabled={disabled}
                onChange={(streaming) => onDefaultsChange({ streaming })}
              />
            </div>
            <div className="w3-co-setup__row">
              <span>Instructions</span>
              <span className="w3-co-setup__links">
                <button
                  type="button"
                  aria-pressed={prompt === 'system'}
                  onClick={() => setPrompt(prompt === 'system' ? null : 'system')}
                >
                  Writing
                </button>
                <button
                  type="button"
                  aria-pressed={prompt === 'analysis'}
                  onClick={() => setPrompt(prompt === 'analysis' ? null : 'analysis')}
                >
                  Example analysis
                </button>
              </span>
            </div>
            {prompt === 'system' ? (
              <Instructions
                label="Writing instructions"
                value={defaults.systemPrompt}
                builtin={DEFAULT_COCREATOR_PROMPT}
                disabled={disabled}
                onApply={(systemPrompt) => onDefaultsChange({ systemPrompt })}
              />
            ) : null}
            {prompt === 'analysis' ? (
              <Instructions
                label="Example analysis instructions"
                value={defaults.analysisPrompt}
                builtin={DEFAULT_COCREATOR_ANALYSIS_PROMPT}
                disabled={disabled}
                onApply={(analysisPrompt) => onDefaultsChange({ analysisPrompt })}
              />
            ) : null}
          </>
        )}
      </div>
    </Popover>
  );
}
