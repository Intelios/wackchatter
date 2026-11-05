import { normalizeSideDefaults } from '@shared/cocreator/sideChat.ts';
import type { ModelRef, ModelSlot, ModelSlots } from '@shared/models/slots.ts';
import type { SideChatModelSettings } from '@shared/types/cocreator.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import { useState } from 'react';
import { NumberField } from '../../components/Field.tsx';
import { Popover } from '../../components/Popover.tsx';
import { GearIcon } from '../../layout/icons.tsx';
import { ModelPicker } from '../models/ModelPicker.tsx';
import type { UseCocreator } from './useCocreator.ts';

export function SideChatSetup({
  design,
  defaults,
  models,
  onModelSlotChange,
  onDefaultsChange,
}: {
  design: UseCocreator;
  defaults: CoCreatorSettings;
  /** The app's model slots: the defaults tab edits `sideChat`. */
  models: ModelSlots;
  onModelSlotChange: (slot: ModelSlot, ref: ModelRef | null) => void;
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'session' | 'defaults'>('defaults');
  const settings: SideChatModelSettings =
    mode === 'defaults' ? {} : (design.state.sideChat?.settings ?? {});
  const outputTokens = settings.outputTokens ?? defaults.sideChat.outputTokens;
  const contextTokens = settings.contextTokens ?? defaults.sideChat.contextTokens;
  const disabled = design.busy || (mode === 'session' && !design.state.sideChat);

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
        <div className="field">
          <span className="wc-label">Side model</span>
          {mode === 'defaults' ? (
            <ModelPicker
              label="Default side-chat model"
              value={models.sideChat}
              onChange={(ref) => onModelSlotChange('sideChat', ref)}
              disabled={disabled}
            />
          ) : (
            <ModelPicker
              label="Side-chat model for this session"
              value={settings.model}
              onChange={(ref) => patch({ model: ref ?? undefined })}
              emptyLabel="Use side-chat default"
              emptyFollows={models.sideChat}
              disabled={disabled}
            />
          )}
        </div>
        <NumberField
          label="Side output tokens"
          value={outputTokens}
          min={1}
          max={2097152}
          disabled={disabled}
          onChange={(outputTokens) => patch({ outputTokens })}
        />
        <NumberField
          label="Side context tokens"
          value={contextTokens}
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
              patch({ model: undefined, outputTokens: undefined, contextTokens: undefined })
            }
          >
            Use all side-chat defaults
          </button>
        ) : null}
        <p className="wc-hint">
          Side chat uses the main Co-Creator sampler preset and streaming setting. Its model is its
          own and never borrows the chat's. Full main context still uses input tokens.
        </p>
      </div>
    </Popover>
  );
}
