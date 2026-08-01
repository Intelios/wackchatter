import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Section } from '../../components/Section.tsx';
import { DownloadIcon, UploadIcon } from '../../layout/icons.tsx';
import { presetApi } from '../../lib/api.ts';
import { PromptEditor } from './PromptEditor.tsx';
import { PromptManager } from './PromptManager.tsx';
import { Slider } from './Slider.tsx';
import './SettingsPanel.css';

const AUTOSAVE_DELAY_MS = 600;

interface SettingsPanelProps {
  presets: PresetSummary[];
  presetId: string | null;
  preset: Preset | null;
  onSelectPreset: (id: string) => void;
  onPresetChange: (preset: Preset) => void;
  onPresetsChanged: () => void;
  tokenCounts?: Record<string, number>;
  /** Connection settings — its own concern, but it belongs in this panel. */
  connection?: ReactNode;
  /** The "what was actually sent" inspector. */
  inspector?: ReactNode;
  /** Which lorebook entries fired, and why the rest did not. */
  worldInfoReport?: ReactNode;
}

export function SettingsPanel({
  presets,
  presetId,
  preset,
  onSelectPreset,
  onPresetChange,
  onPresetsChanged,
  tokenCounts,
  connection,
  inspector,
  worldInfoReport,
}: SettingsPanelProps) {
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const fileInput = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);

  // Debounced save of the whole preset. Presets are small, and writing the whole file
  // keeps the on-disk format identical to what SillyTavern produces.
  useEffect(() => {
    if (!preset || !presetId || !dirtyRef.current) return;

    const timer = setTimeout(async () => {
      try {
        await presetApi.save(presetId, preset);
        dirtyRef.current = false;
        setStatus('Saved');
      } catch (err) {
        setStatus((err as Error).message);
      }
    }, AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [preset, presetId]);

  function change(next: Preset) {
    dirtyRef.current = true;
    setStatus('');
    onPresetChange(next);
  }

  function setField(key: keyof Preset, value: unknown) {
    if (!preset) return;
    change({ ...preset, [key]: value });
  }

  async function handleImport(file: File | undefined) {
    if (!file) return;
    try {
      const imported = await presetApi.import(file);
      onPresetsChanged();
      onSelectPreset(imported.id);
      setStatus(`Imported as “${imported.id}”`);
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  if (!preset) {
    return <div className="wc-empty">Loading presets…</div>;
  }

  return (
    <div className="settings-panel">
      {connection ? (
        <Section title="Connection" defaultOpen={!preset.chat_completion_source}>
          {connection}
        </Section>
      ) : null}

      <div className="settings-panel__preset">
        <select
          className="wc-select"
          value={presetId ?? ''}
          onChange={(e) => onSelectPreset(e.target.value)}
          aria-label="Active preset"
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="wc-button wc-button--ghost"
          title="Import preset"
          aria-label="Import preset"
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon />
        </button>

        <a
          className="wc-button wc-button--ghost"
          title="Export preset"
          aria-label="Export preset"
          href={presetId ? presetApi.exportUrl(presetId) : undefined}
          download
        >
          <DownloadIcon />
        </a>

        <input
          ref={fileInput}
          type="file"
          accept=".json"
          className="wc-visually-hidden"
          onChange={(e) => {
            handleImport(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {status ? <div className="settings-panel__status">{status}</div> : null}

      <Section title="Prompts" defaultOpen badge={`${preset.prompts?.length ?? 0}`}>
        <PromptManager
          preset={preset}
          onChange={change}
          selected={selectedPrompt}
          onSelect={setSelectedPrompt}
          tokenCounts={tokenCounts}
        />
      </Section>

      {selectedPrompt ? (
        <PromptEditor
          preset={preset}
          identifier={selectedPrompt}
          onChange={change}
          onClose={() => setSelectedPrompt(null)}
        />
      ) : null}

      <Section title="Generation" defaultOpen>
        <Slider
          label="Temperature"
          value={preset.temperature ?? 1}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => setField('temperature', v)}
        />
        <Slider
          label="Top P"
          value={preset.top_p ?? 1}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setField('top_p', v)}
        />
        <Slider
          label="Frequency penalty"
          value={preset.frequency_penalty ?? 0}
          min={-2}
          max={2}
          step={0.01}
          onChange={(v) => setField('frequency_penalty', v)}
        />
        <Slider
          label="Presence penalty"
          value={preset.presence_penalty ?? 0}
          min={-2}
          max={2}
          step={0.01}
          onChange={(v) => setField('presence_penalty', v)}
        />
      </Section>

      <Section title="Context" defaultOpen>
        <Slider
          label="Max context"
          value={preset.openai_max_context ?? 4095}
          min={512}
          max={200000}
          step={1}
          onChange={(v) => setField('openai_max_context', Math.round(v))}
        />
        <Slider
          label="Max response"
          value={preset.openai_max_tokens ?? 300}
          min={16}
          max={16384}
          step={1}
          onChange={(v) => setField('openai_max_tokens', Math.round(v))}
        />
        <label className="settings-panel__check">
          <input
            type="checkbox"
            checked={Boolean(preset.squash_system_messages)}
            onChange={(e) => setField('squash_system_messages', e.target.checked)}
          />
          <span>
            Squash system messages
            <span className="wc-hint">Merge consecutive system messages into one.</span>
          </span>
        </label>
        <label className="settings-panel__check">
          <input
            type="checkbox"
            checked={preset.stream_openai !== false}
            onChange={(e) => setField('stream_openai', e.target.checked)}
          />
          <span>Stream responses</span>
        </label>
      </Section>

      {worldInfoReport ? <Section title="World Info">{worldInfoReport}</Section> : null}
      {inspector ? <Section title="Last request">{inspector}</Section> : null}
    </div>
  );
}
