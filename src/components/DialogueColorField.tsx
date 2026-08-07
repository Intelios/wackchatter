import type { DialogueColorOverride } from '@shared/types/settings.ts';
import { useEffect, useId, useState } from 'react';
import { contrastRatio } from '../features/chat/avatarColor.ts';
import { SelectField } from './Field.tsx';
import './DialogueColorField.css';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FALLBACK_COLOR = '#e18a24';

/**
 * One-click dialogue colours for the custom mode. Every value passes the same 4.5:1
 * contrast check the field warns about, so no preset ships a colour the editor would
 * flag on its own input.
 */
const DIALOGUE_COLOR_PRESETS = [
  { label: 'Orange', value: '#e18a24' },
  { label: 'Red', value: '#ff6b6b' },
  { label: 'Pink', value: '#ff8fa3' },
  { label: 'Purple', value: '#a78bfa' },
  { label: 'Blue', value: '#51a0de' },
  { label: 'Teal', value: '#2dd4bf' },
  { label: 'Green', value: '#46a758' },
  { label: 'Yellow', value: '#f7c948' },
] as const;

interface DialogueColorFieldProps {
  value: DialogueColorOverride | undefined;
  autoColor: string | null;
  globallyEnabled: boolean;
  onChange: (value: DialogueColorOverride | undefined) => void;
}

/** Shared by character and persona editors so their three-state semantics cannot drift. */
export function DialogueColorField({
  value,
  autoColor,
  globallyEnabled,
  onChange,
}: DialogueColorFieldProps) {
  const id = useId();
  const mode = value === undefined ? 'auto' : value === null ? 'off' : 'custom';
  const [draft, setDraft] = useState(
    typeof value === 'string' ? value : (autoColor ?? FALLBACK_COLOR),
  );

  useEffect(() => {
    if (typeof value === 'string') setDraft(value);
    else if (mode === 'auto') setDraft(autoColor ?? FALLBACK_COLOR);
  }, [autoColor, mode, value]);

  const customValid = HEX_COLOR.test(draft);
  const preview = mode === 'custom' && customValid ? draft : autoColor;
  const lowContrast = mode === 'custom' && customValid && contrastRatio(draft, '#2b2b2d') < 4.5;

  return (
    <div className="dialogue-color-field">
      <SelectField<'auto' | 'custom' | 'off'>
        label="Dialogue colour"
        value={mode}
        options={[
          { label: 'Auto — from avatar', value: 'auto' },
          { label: 'Custom', value: 'custom' },
          { label: 'Off for this speaker', value: 'off' },
        ]}
        onChange={(next) => {
          if (next === 'auto') onChange(undefined);
          else if (next === 'off') onChange(null);
          else {
            const color = autoColor ?? FALLBACK_COLOR;
            setDraft(color);
            onChange(color);
          }
        }}
        hint={
          globallyEnabled
            ? 'Colours completed dialogue in straight or curly double quotes.'
            : 'Saved, but the global dialogue-colouring switch is currently off.'
        }
      />

      {mode !== 'off' ? (
        <div className="dialogue-color-field__preview-row">
          <span
            className="dialogue-color-field__swatch"
            style={preview ? { backgroundColor: preview } : undefined}
            title={preview ?? 'Default dialogue colour'}
            aria-hidden="true"
          />
          <span className="wc-hint">
            {mode === 'auto'
              ? autoColor
                ? `Avatar colour ${autoColor}`
                : 'Using the default orange until an avatar colour is available.'
              : 'Custom colour is used exactly as entered.'}
          </span>
        </div>
      ) : null}

      {mode === 'custom' ? (
        <div className="field">
          <label className="wc-label" htmlFor={id}>
            Custom colour
          </label>
          <div className="dialogue-color-field__custom">
            <input
              className="dialogue-color-field__picker"
              type="color"
              value={customValid ? draft : FALLBACK_COLOR}
              aria-label="Pick dialogue colour"
              onChange={(event) => {
                const color = event.target.value.toLowerCase();
                setDraft(color);
                onChange(color);
              }}
            />
            <input
              id={id}
              className="wc-input"
              value={draft}
              spellCheck={false}
              onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                if (HEX_COLOR.test(next)) onChange(next.toLowerCase());
              }}
              onBlur={() => {
                if (!customValid) setDraft(typeof value === 'string' ? value : FALLBACK_COLOR);
              }}
            />
          </div>
          <fieldset className="dialogue-color-field__presets">
            <legend className="wc-label">Preset colours</legend>
            {DIALOGUE_COLOR_PRESETS.map((preset) => {
              const selected = preset.value === draft;
              return (
                <button
                  key={preset.value}
                  type="button"
                  className="dialogue-color-field__preset"
                  style={{ backgroundColor: preset.value }}
                  title={`${preset.label} — ${preset.value}`}
                  aria-label={`Use ${preset.label} dialogue colour`}
                  aria-pressed={selected}
                  onClick={() => {
                    setDraft(preset.value);
                    onChange(preset.value);
                  }}
                />
              );
            })}
          </fieldset>
          {!customValid ? (
            <p className="wc-hint">Enter a six-digit hex colour such as #e18a24.</p>
          ) : null}
          {lowContrast ? (
            <p className="wc-hint dialogue-color-field__warning">
              This colour may be difficult to read on message bubbles.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
