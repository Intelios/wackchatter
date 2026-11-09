import { HEX_COLOR, minimumGradientContrast, paletteGradient } from '@shared/colors/color.ts';
import type { DialogueColorOverride } from '@shared/types/settings.ts';
import { type CSSProperties, useEffect, useId, useState } from 'react';
import {
  type PortraitPalette,
  paletteConfiguration,
  portraitSuggestions,
  resolveSpeakerColors,
  withPaletteColors,
  withPaletteTreatment,
} from '../features/chat/portraitPalette.ts';
import { initialAuraStyle } from '../shell/useAura.ts';
import './DialogueColorField.css';
import '../features/chat/dialogueGradient.css';

const FALLBACK_COLOR = '#a3a3a3';

export const DIALOGUE_COLOR_PRESETS = [
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
  autoPalette: PortraitPalette | null;
  globallyEnabled?: boolean;
  onChange: (value: DialogueColorOverride | undefined) => void;
}

/** One editor for characters and personas in both shells. Changes autosave as before. */
export function DialogueColorField({
  value,
  autoPalette,
  globallyEnabled = true,
  onChange,
}: DialogueColorFieldProps) {
  const config = paletteConfiguration(value);
  const resolved = resolveSpeakerColors(true, value, autoPalette);
  const colors = resolved.colors.length ? resolved.colors : [FALLBACK_COLOR];
  const suggestions = portraitSuggestions(autoPalette);
  const lowContrast =
    config.source === 'custom' &&
    config.dialogue !== 'off' &&
    minimumGradientContrast(config.dialogue === 'gradient' ? colors : colors.slice(0, 1)) < 4.5;
  const pin = (next: string[]) => onChange(withPaletteColors(value, next));
  const needsMore =
    new Set(colors).size < 2 && (config.aura === 'gradient' || config.dialogue === 'gradient');

  return (
    <div className="dialogue-color-field">
      <fieldset className="dialogue-color-field__sources" aria-label="Palette source">
        <button
          type="button"
          aria-pressed={config.source === 'portrait'}
          onClick={() =>
            onChange({ source: 'portrait', aura: config.aura, dialogue: config.dialogue })
          }
        >
          From portrait
        </button>
        <button
          type="button"
          aria-pressed={config.source === 'custom'}
          onClick={() => pin([...colors])}
        >
          Custom
        </button>
      </fieldset>

      {suggestions.length > 0 ? (
        <fieldset className="dialogue-color-field__suggestions">
          <legend>
            Portrait picks <span>— choosing one keeps its colours</span>
          </legend>
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.join(',')}
              type="button"
              aria-label={`Keep portrait palette ${index + 1}: ${suggestion.join(', ')}`}
              title={`Keep ${suggestion.join(' → ')}`}
              aria-pressed={
                config.source === 'custom' && config.colors.join(',') === suggestion.join(',')
              }
              onClick={() => pin(suggestion)}
            >
              <i style={{ background: paletteGradient(suggestion) ?? suggestion[0] }} />
              {index + 1}
            </button>
          ))}
        </fieldset>
      ) : null}

      <fieldset className="dialogue-color-field__presets">
        <legend>Solid colours</legend>
        {DIALOGUE_COLOR_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className="dialogue-color-field__preset"
            style={{ background: preset.value }}
            title={preset.label}
            aria-label={`Use ${preset.label} colour`}
            aria-pressed={
              config.source === 'custom' &&
              config.colors.length === 1 &&
              config.colors[0] === preset.value
            }
            onClick={() => pin([preset.value])}
          />
        ))}
      </fieldset>

      {config.source === 'custom' ? (
        <div className="dialogue-color-field__stops">
          {config.colors.map((color, index) => (
            <ColorStop
              // biome-ignore lint/suspicious/noArrayIndexKey: stops are numbered positions; editing a hex must not remount the focused input
              key={index}
              value={color}
              index={index}
              count={config.colors.length}
              onChange={(next) => pin(config.colors.map((old, i) => (i === index ? next : old)))}
              onRemove={() => pin(config.colors.filter((_, i) => i !== index))}
              onMove={(direction) => {
                const next = [...config.colors];
                const target = index + direction;
                [next[index], next[target]] = [next[target]!, next[index]!];
                pin(next);
              }}
            />
          ))}
          {config.colors.length < 3 ? (
            <button
              type="button"
              className="dialogue-color-field__add"
              onClick={() =>
                pin([
                  ...config.colors,
                  autoPalette?.candidates.find((color) => !config.colors.includes(color)) ??
                    config.colors[0]!,
                ])
              }
            >
              + Add colour
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="dialogue-color-field__treatments">
        <fieldset>
          <legend>Aura</legend>
          {(['single', 'gradient'] as const).map((treatment) => (
            <button
              key={treatment}
              type="button"
              aria-pressed={config.aura === treatment}
              onClick={() => onChange(withPaletteTreatment(value, 'aura', treatment))}
            >
              {treatment === 'single' ? 'Single' : 'Gradient'}
            </button>
          ))}
        </fieldset>
        <fieldset>
          <legend>Dialogue</legend>
          {(['solid', 'gradient', 'off'] as const).map((treatment) => (
            <button
              key={treatment}
              type="button"
              aria-pressed={config.dialogue === treatment}
              onClick={() => onChange(withPaletteTreatment(value, 'dialogue', treatment))}
            >
              {treatment === 'solid' ? 'Solid' : treatment === 'gradient' ? 'Gradient' : 'Off'}
            </button>
          ))}
        </fieldset>
      </div>

      <div
        className="dialogue-color-field__preview"
        style={
          {
            ...initialAuraStyle(resolved.aura, null),
            '--wc-dialogue-color': resolved.dialogue.color ?? 'var(--wc-text)',
            '--dialogue-gradient': resolved.dialogue.gradient ?? 'none',
          } as CSSProperties
        }
      >
        <span className="dialogue-color-field__preview-label">Preview</span>
        <p>
          <q
            className="dialogue-color-field__quote"
            data-gradient={!!resolved.dialogue.gradient || undefined}
          >
            “Shall we see where this leads?”
          </q>{' '}
          they ask.
        </p>
      </div>
      {needsMore ? (
        <p className="wc-hint">
          A gradient needs two different colours. Until then, it uses a single colour.
        </p>
      ) : null}
      {lowContrast ? (
        <p className="wc-hint dialogue-color-field__warning">
          This colour or part of the blend may be difficult to read on message bubbles. Your colours
          are kept exactly as entered.
        </p>
      ) : null}
      {!globallyEnabled ? (
        <p className="wc-hint">
          Dialogue colours are switched off in Settings. Aura still follows this palette.
        </p>
      ) : null}
    </div>
  );
}

function ColorStop({
  value,
  index,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  value: string;
  index: number;
  count: number;
  onChange: (color: string) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="dialogue-color-field__stop">
      <label htmlFor={id}>{index === 0 ? 'Main' : `Colour ${index + 1}`}</label>
      <input
        type="color"
        value={value}
        aria-label={`Pick colour ${index + 1}`}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
      />
      <input
        id={id}
        className="wc-input"
        value={draft}
        spellCheck={false}
        maxLength={7}
        aria-label={`Colour ${index + 1} hex`}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (HEX_COLOR.test(next)) onChange(next.toLowerCase());
        }}
        onBlur={() => setDraft(value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(value);
          }
        }}
      />
      <button
        type="button"
        aria-label={`Move colour ${index + 1} earlier`}
        title={index ? 'Move earlier' : 'Already first'}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`Move colour ${index + 1} later`}
        title={index < count - 1 ? 'Move later' : 'Already last'}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label={`Remove colour ${index + 1}`}
        title={count > 1 ? 'Remove colour' : 'Keep at least one colour'}
        disabled={count < 2}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
