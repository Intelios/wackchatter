import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatBackupSummary } from '@shared/types/chat.ts';
import { DEFAULT_DIALOGUE_COLORS, type SettingsResponse } from '@shared/types/settings.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckField, NumberField, SelectField, TagField } from '../../components/Field.tsx';
import { Section } from '../../components/Section.tsx';
import { Slider } from '../../components/Slider.tsx';
import { TrashIcon, UploadIcon } from '../../layout/icons.tsx';
import { type BackgroundSummary, backgroundApi } from '../../lib/api.ts';
import { RegexScriptSection } from '../regex/RegexScriptList.tsx';
import { BUILTIN_BACKGROUNDS } from './backgrounds.ts';
import { DataLocationSection } from './DataLocationSection.tsx';
import { RecentlyDeletedSection } from './RecentlyDeletedSection.tsx';
import './UserSettingsPanel.css';

interface UserSettingsPanelProps {
  settings: SettingsResponse | null;
  onPatch: (patch: Record<string, unknown>) => void;
  /** Moving the data folder reloads the app, which would take an unsaved draft with it. */
  unsavedPreset?: boolean;
  /** The chat trash bin, across every character — see RecentlyDeletedSection. */
  backups: ChatBackupSummary[];
  characters: CharacterSummary[];
  onRestoreBackup: (backupId: string) => void;
  onPurgeBackup: (backupId: string) => void;
}

/** App-level settings: how the app looks, where data lives, and the knobs with no better home. */
export function UserSettingsPanel({
  settings,
  onPatch,
  unsavedPreset,
  backups,
  characters,
  onRestoreBackup,
  onPurgeBackup,
}: UserSettingsPanelProps) {
  const [uploads, setUploads] = useState<BackgroundSummary[]>([]);
  const [status, setStatus] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setUploads(await backgroundApi.list());
    } catch (err) {
      setStatus((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = typeof settings?.background === 'string' ? settings.background : null;

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    try {
      const saved = await backgroundApi.upload(file);
      await refresh();
      onPatch({ background: `user:${saved.name}` });
      setStatus('');
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  async function handleDelete(name: string) {
    try {
      await backgroundApi.remove(name);
      // Clearing the selection in the same action, or the app shows a broken image.
      if (selected === `user:${name}`) onPatch({ background: null });
      setConfirmDelete(null);
      await refresh();
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  async function handleImport() {
    setStatus('Importing…');
    try {
      const result = await backgroundApi.importFromSillyTavern();
      await refresh();
      setStatus(
        result.imported.length === 0
          ? `Nothing new to import — all ${result.skipped.length} already here.`
          : `Imported ${result.imported.length}, skipped ${result.skipped.length} already here.`,
      );
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  return (
    <div className="user-settings">
      <Section title="Background">
        <div className="user-settings__grid">
          <button
            type="button"
            className="user-settings__swatch user-settings__swatch--none"
            data-selected={selected === null || undefined}
            onClick={() => onPatch({ background: null })}
            title="No background"
          >
            <span>None</span>
          </button>

          {BUILTIN_BACKGROUNDS.map((background) => (
            <button
              key={background.id}
              type="button"
              className="user-settings__swatch"
              data-selected={selected === `builtin:${background.id}` || undefined}
              style={{ backgroundImage: `url("${background.url}")` }}
              onClick={() => onPatch({ background: `builtin:${background.id}` })}
              title={background.label}
            >
              <span>{background.label}</span>
            </button>
          ))}

          {uploads.map((upload) => (
            <div key={upload.name} className="user-settings__upload">
              <button
                type="button"
                className="user-settings__swatch"
                data-selected={selected === `user:${upload.name}` || undefined}
                style={{
                  backgroundImage: `url("${backgroundApi.url(upload.name, upload.modified)}")`,
                }}
                onClick={() => onPatch({ background: `user:${upload.name}` })}
                title={upload.name}
              >
                <span>{upload.name}</span>
              </button>
              {/* Two-click confirm in place: destructive, but never a blocking dialog. */}
              <button
                type="button"
                className="wc-button wc-button--ghost wc-button--danger user-settings__delete"
                onClick={() =>
                  confirmDelete === upload.name
                    ? void handleDelete(upload.name)
                    : setConfirmDelete(upload.name)
                }
                onBlur={() => setConfirmDelete(null)}
                title={confirmDelete === upload.name ? 'Click again to delete' : 'Delete'}
                aria-label={
                  confirmDelete === upload.name
                    ? `Click again to delete ${upload.name}`
                    : `Delete ${upload.name}`
                }
                data-confirming={confirmDelete === upload.name || undefined}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>

        <div className="user-settings__actions">
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => fileInput.current?.click()}
          >
            <UploadIcon />
            Upload
          </button>
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => void handleImport()}
          >
            Import from SillyTavern
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="wc-visually-hidden"
            onChange={(e) => {
              void handleUpload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>

        {status ? <p className="wc-hint">{status}</p> : null}

        <Slider
          label="Blur"
          value={Number(settings?.backgroundBlur ?? 8)}
          min={0}
          max={40}
          step={1}
          onChange={(v) => onPatch({ backgroundBlur: Math.round(v) })}
        />
        <Slider
          label="Dim"
          value={Number(settings?.backgroundDim ?? 0.55)}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => onPatch({ backgroundDim: v })}
        />
        <CheckField
          label="Glass surfaces"
          checked={settings?.glass !== false}
          onChange={(checked) => onPatch({ glass: checked })}
          hint="Panels and bubbles let the background through. Ignored with no background set."
        />
      </Section>

      <Section title="Dialogue colour">
        <CheckField
          label="Colour quoted dialogue"
          checked={settings?.dialogueColors?.enabled ?? DEFAULT_DIALOGUE_COLORS.enabled}
          onChange={(enabled) =>
            onPatch({
              dialogueColors: {
                enabled,
                characters: settings?.dialogueColors?.characters ?? {},
                personas: settings?.dialogueColors?.personas ?? {},
              },
            })
          }
          hint="Uses each character or persona avatar by default. Individual speakers can use a custom colour or opt out in their editor."
        />
      </Section>

      <Section title="Hidden tags">
        <TagField
          label="Tags to hide"
          value={settings?.hiddenTags ?? []}
          onChange={(hiddenTags) => onPatch({ hiddenTags })}
          hint="These tags do not appear as chips on character cards. The cards themselves remain visible."
        />
      </Section>

      <RegexScriptSection
        scripts={settings?.regexScripts ?? []}
        onChange={(regexScripts) => onPatch({ regexScripts })}
      />

      <Section title="Advanced">
        <NumberField
          label="Streaming refresh rate"
          value={Number(settings?.streamingFps ?? 30)}
          min={5}
          max={120}
          step={1}
          onChange={(value) => onPatch({ streamingFps: Math.round(value) })}
          hint="How often the reply repaints while tokens arrive, in frames per second."
        />
        <SelectField<'auto' | 'o200k_base' | 'cl100k_base'>
          label="Tokenizer"
          value={
            (settings?.tokenizerEncoding as 'auto' | 'o200k_base' | 'cl100k_base' | undefined) ??
            'auto'
          }
          options={[
            { label: 'Infer from the model id', value: 'auto' },
            { label: 'o200k_base (GPT-4o and newer)', value: 'o200k_base' },
            { label: 'cl100k_base (GPT-4, GPT-3.5)', value: 'cl100k_base' },
          ]}
          onChange={(value) => onPatch({ tokenizerEncoding: value })}
          hint="Counts are exact for OpenAI models and an estimate everywhere else."
        />
      </Section>

      <RecentlyDeletedSection
        backups={backups}
        characters={characters}
        onRestore={onRestoreBackup}
        onPurge={onPurgeBackup}
      />

      <DataLocationSection unsavedPreset={unsavedPreset} />
    </div>
  );
}
