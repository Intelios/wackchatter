import { deleteCustomPrompt, getPromptById } from '@shared/prompt/preset-io.ts';
import type { MacroWarning } from '@shared/types/chat.ts';
import { CHARACTER_NAMES_BEHAVIOR, type Preset, type PresetSummary } from '@shared/types/preset.ts';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { DownloadIcon, EditIcon, UploadIcon } from '../../layout/icons.tsx';
import { presetApi } from '../../lib/api.ts';
import { PromptEditor } from './PromptEditor.tsx';
import { PromptManager } from './PromptManager.tsx';
import { Slider } from './Slider.tsx';
import './SettingsPanel.css';

interface SettingsPanelProps {
  presets: PresetSummary[];
  presetId: string | null;
  preset: Preset | null;
  onSelectPreset: (id: string) => void;
  onPresetChange: (preset: Preset) => void;
  onPresetsChanged: () => void;
  /** Re-read the preset from disk, discarding the working copy. */
  onRevertPreset: () => void;
  tokenCounts?: Record<string, number>;
  macroWarnings?: MacroWarning[];
  /** Whether the active provider sends OpenRouter-style extra samplers. */
  extraSamplersSent?: boolean;
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
  onRevertPreset,
  tokenCounts,
  macroWarnings = [],
  extraSamplersSent = false,
  connection,
  inspector,
  worldInfoReport,
}: SettingsPanelProps) {
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Unsaved edits to the working copy.
   *
   * Presets used to autosave on a debounce, which meant there was no way back from a
   * tweak you disliked — the original was already overwritten. Saving is explicit now,
   * and `dirty` is what Save, Revert and the switch guard all key off.
   */
  const [dirty, setDirty] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  /**
   * The last preset object this panel produced.
   *
   * `preset` changes identity on every keystroke, so "did it change?" cannot distinguish
   * an edit from a fresh load. Anything we did not hand up ourselves — a different preset
   * selected, a revert, a rename — is a load, and a load arrives clean.
   */
  const ownEdit = useRef<Preset | null>(null);

  useEffect(() => {
    if (preset && preset === ownEdit.current) return;
    setDirty(false);
    setStatus('');
  }, [preset]);

  function change(next: Preset) {
    ownEdit.current = next;
    setDirty(true);
    setStatus('');
    onPresetChange(next);
  }

  async function handleSave() {
    if (!preset || !presetId) return;
    try {
      await presetApi.save(presetId, preset);
      setDirty(false);
      setStatus('Saved');
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  async function handleRename(next: string) {
    setRenaming(false);
    if (!presetId || !next.trim() || next.trim() === presetId) return;
    try {
      const summary = await presetApi.rename(presetId, next.trim());
      onPresetsChanged();
      // No success status: selecting the new id reloads the preset, and a fresh load
      // clears the status. The renamed entry in the picker is the confirmation. Errors
      // do not reload, so those still show.
      onSelectPreset(summary.id);
    } catch (err) {
      setStatus((err as Error).message);
    }
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

  // Resolved rather than trusted: a selection can outlive its prompt (deleted here, or
  // gone after switching preset), and PromptEditor renders nothing for a missing one —
  // which would leave an empty panel with no way back.
  const editing = selectedPrompt ? getPromptById(preset, selectedPrompt) : null;

  // Rendered in both views. Most preset edits happen inside the prompt editor, and a Save
  // button you have to navigate away from to reach is a Save button people lose work to.
  const unsavedBar = dirty ? (
    // <output> rather than a div with role="status" — it is the semantic element for it.
    <output className="settings-panel__unsaved">
      <span className="settings-panel__unsaved-text">Unsaved changes</span>
      <button type="button" className="wc-button wc-button--ghost" onClick={onRevertPreset}>
        Revert
      </button>
      <button
        type="button"
        className="wc-button wc-button--primary"
        onClick={() => void handleSave()}
      >
        Save
      </button>
    </output>
  ) : null;

  if (selectedPrompt && editing) {
    return (
      <div className="settings-panel__editing">
        {unsavedBar}
        <PromptEditor
          preset={preset}
          identifier={selectedPrompt}
          onChange={change}
          onClose={() => setSelectedPrompt(null)}
          onDelete={(identifier) => {
            change(deleteCustomPrompt(preset, identifier));
            setSelectedPrompt(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="settings-panel">
      {connection ? (
        <Section title="Connection" defaultOpen={!preset.chat_completion_source}>
          {connection}
        </Section>
      ) : null}

      <div className="settings-panel__preset">
        {renaming ? (
          <input
            className="wc-input"
            // biome-ignore lint/a11y/noAutofocus: the field only exists once rename is clicked
            autoFocus
            aria-label="Preset name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => void handleRename(nameDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <select
            className="wc-select"
            value={presetId ?? ''}
            // Switching would replace the working copy, so unsaved edits have to be
            // resolved first. Disabled rather than prompting: no modals, and the
            // Save/Revert bar below says exactly what to do about it.
            disabled={dirty}
            onChange={(e) => onSelectPreset(e.target.value)}
            aria-label="Active preset"
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          className="wc-button wc-button--ghost"
          title="Rename preset"
          aria-label="Rename preset"
          disabled={dirty || !presetId}
          onClick={() => {
            setNameDraft(presetId ?? '');
            setRenaming(true);
          }}
        >
          <EditIcon />
        </button>

        <button
          type="button"
          className="wc-button wc-button--ghost"
          title="Import preset"
          aria-label="Import preset"
          disabled={dirty}
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

      {unsavedBar}

      {status ? <div className="settings-panel__status">{status}</div> : null}

      {macroWarnings.length > 0 ? (
        <details className="settings-panel__warnings">
          <summary>
            {macroWarnings.length} unresolved macro{macroWarnings.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {macroWarnings.map((warning) => (
              <li key={`${warning.source}:${warning.macro}`}>
                <code>{warning.macro}</code> in {warning.source}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <Section title="Prompts" defaultOpen badge={`${preset.prompts?.length ?? 0}`}>
        <PromptManager
          preset={preset}
          onChange={change}
          selected={selectedPrompt}
          onSelect={setSelectedPrompt}
          tokenCounts={tokenCounts}
        />
      </Section>

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
          label="Top K"
          value={preset.top_k ?? 0}
          min={0}
          max={200}
          step={1}
          onChange={(v) => setField('top_k', Math.round(v))}
        />
        <Slider
          label="Top A"
          value={preset.top_a ?? 0}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setField('top_a', v)}
        />
        <Slider
          label="Min P"
          value={preset.min_p ?? 0}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setField('min_p', v)}
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
        <Slider
          label="Repetition penalty"
          value={preset.repetition_penalty ?? 1}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => setField('repetition_penalty', v)}
        />
        {!extraSamplersSent ? (
          <p className="wc-hint">
            Top K, Top A, Min P and repetition penalty are preserved but not sent by the active
            provider.
          </p>
        ) : null}
        <div className="field-row">
          <NumberField
            label="Seed"
            value={preset.seed ?? -1}
            min={-1}
            step={1}
            onChange={(value) => setField('seed', Math.round(value))}
            hint="-1 lets the provider choose."
          />
          <NumberField
            label="Completions"
            value={preset.n ?? 1}
            min={1}
            step={1}
            onChange={(value) => setField('n', Math.max(1, Math.round(value)))}
          />
        </div>
      </Section>

      <Section title="Formatting">
        <SelectField<number>
          label="Names in prompt"
          value={preset.names_behavior ?? CHARACTER_NAMES_BEHAVIOR.DEFAULT}
          options={[
            { label: 'None', value: CHARACTER_NAMES_BEHAVIOR.NONE },
            { label: 'Default', value: CHARACTER_NAMES_BEHAVIOR.DEFAULT },
            { label: 'Completion name field', value: CHARACTER_NAMES_BEHAVIOR.COMPLETION },
            { label: 'Prefix message content', value: CHARACTER_NAMES_BEHAVIOR.CONTENT },
          ]}
          onChange={(value) => setField('names_behavior', value)}
        />
        <TextField
          label="World Info format"
          value={preset.wi_format ?? '{0}'}
          onChange={(value) => setField('wi_format', value)}
          hint="Use {0} for the activated lore text."
        />
        <TextField
          label="Personality format"
          value={preset.personality_format ?? '{{personality}}'}
          onChange={(value) => setField('personality_format', value)}
        />
        <TextField
          label="Scenario format"
          value={preset.scenario_format ?? '{{scenario}}'}
          onChange={(value) => setField('scenario_format', value)}
        />
        <TextField
          label="New chat marker"
          value={preset.new_chat_prompt ?? '[Start a new Chat]'}
          onChange={(value) => setField('new_chat_prompt', value)}
          multiline
        />
        <TextField
          label="Example dialogue marker"
          value={preset.new_example_chat_prompt ?? '[Example Chat]'}
          onChange={(value) => setField('new_example_chat_prompt', value)}
        />
        <TextField
          label="Send if history ends on assistant"
          value={preset.send_if_empty ?? ''}
          onChange={(value) => setField('send_if_empty', value)}
          hint="Leave empty to disable the compatibility message."
        />
      </Section>

      <Section title="Continue">
        <TextField
          label="Continue nudge"
          value={
            preset.continue_nudge_prompt ??
            '[Continue your last message without repeating its original content.]'
          }
          onChange={(value) => setField('continue_nudge_prompt', value)}
          multiline
        />
        <CheckField
          label="Use assistant prefill"
          checked={Boolean(preset.continue_prefill)}
          onChange={(checked) => setField('continue_prefill', checked)}
          hint="Moves the partial assistant reply to the end instead of adding a nudge."
        />
        <TextField
          label="Continue postfix"
          value={preset.continue_postfix ?? ' '}
          onChange={(value) => setField('continue_postfix', value)}
          hint="Inserted between the existing reply and newly generated text."
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
