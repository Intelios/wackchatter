import type { PresetSummary } from '@shared/types/preset.ts';
import { useRef, useState } from 'react';
import { CopyIcon, DownloadIcon, EditIcon, TrashIcon, UploadIcon } from '../../layout/icons.tsx';
import { presetApi } from '../../lib/api.ts';
import type { PresetDraft } from './usePresetDraft.ts';
import './PresetToolbar.css';

interface PresetToolbarProps {
  presets: PresetSummary[];
  presetId: string | null;
  onSelectPreset: (id: string) => void;
  draft: PresetDraft;
}

/**
 * Which preset is active, and the file operations on it.
 *
 * Shown only on the panels that edit a preset. Above the Connection form it would be
 * noise, and Inspect is read-only.
 */
export function PresetToolbar({ presets, presetId, onSelectPreset, draft }: PresetToolbarProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Disabled beats refused: the reason a delete cannot happen becomes the button's title.
  const deleteBlocked = !presetId
    ? 'No preset selected.'
    : draft.dirty
      ? 'Save or revert unsaved edits before deleting.'
      : presets.length <= 1
        ? 'The last preset cannot be deleted — duplicate or import another first.'
        : null;
  const deleteTitle = confirmDelete ? 'Click again to delete' : (deleteBlocked ?? 'Delete preset');

  function handleDelete() {
    setConfirmDelete(false);
    void draft.remove();
  }

  return (
    <div className="preset-toolbar">
      <div className="preset-toolbar__row">
        {draft.renaming ? (
          <input
            className="wc-input"
            // biome-ignore lint/a11y/noAutofocus: the field only exists once rename is clicked
            autoFocus
            aria-label="Preset name"
            value={draft.nameDraft}
            onChange={(e) => draft.setNameDraft(e.target.value)}
            onBlur={() => void draft.rename(draft.nameDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') draft.cancelRename();
            }}
          />
        ) : (
          <select
            className="wc-select"
            value={presetId ?? ''}
            // Switching would replace the working copy, so unsaved edits have to be
            // resolved first. Disabled rather than prompting: no modals, and the
            // Save/Revert bar directly below says exactly what to do about it.
            disabled={draft.dirty}
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
          disabled={draft.dirty || !presetId}
          onClick={draft.startRename}
        >
          <EditIcon />
        </button>

        <button
          type="button"
          className="wc-button wc-button--ghost"
          title="Duplicate preset"
          aria-label="Duplicate preset"
          disabled={!presetId}
          onClick={() => void draft.duplicate()}
        >
          <CopyIcon />
        </button>

        <button
          type="button"
          className="wc-button wc-button--ghost"
          title="Import preset"
          aria-label="Import preset"
          disabled={draft.dirty}
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

        {/* A two-click confirm in place, per the no-modals rule. Locked while dirty like
            rename/import — the Save/Revert bar below is how unsaved edits get resolved —
            and the last preset is undeletable: the app needs one to generate. */}
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger"
          title={deleteTitle}
          aria-label={confirmDelete ? 'Click again to delete preset' : 'Delete preset'}
          disabled={deleteBlocked !== null}
          onClick={() => (confirmDelete ? handleDelete() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
        >
          <TrashIcon />
          {confirmDelete ? 'Click again' : null}
        </button>

        <input
          ref={fileInput}
          type="file"
          accept=".json"
          className="wc-visually-hidden"
          onChange={(e) => {
            void draft.importPreset(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {draft.status ? <div className="preset-toolbar__status">{draft.status}</div> : null}
    </div>
  );
}
