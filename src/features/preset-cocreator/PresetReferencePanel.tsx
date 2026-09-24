import type { PresetSummary } from '@shared/types/preset.ts';
import type { ReferencePresetSummary } from '@shared/types/preset-cocreator.ts';
import { useRef, useState } from 'react';
import { Select } from '../../components/Select.tsx';
import { UploadIcon } from '../../layout/icons.tsx';
import { referencePresetApi } from '../../lib/api.ts';
import { formatTimestamp } from '../chat/formatDate.ts';

interface PresetReferencePanelProps {
  references: readonly ReferencePresetSummary[];
  /** The user's own library presets, offered for copying in one at a time. */
  presets: readonly PresetSummary[];
  /** Called after any mutation so the parent can re-list. */
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}

/**
 * The read-only example preset folder, managed from the sessions landing page. These
 * files feed the assistant's read_reference_preset tool — they never appear in the
 * library preset list, and nothing here edits them.
 */
export function PresetReferencePanel({
  references,
  presets,
  onChanged,
  onError,
}: PresetReferencePanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openRaw, setOpenRaw] = useState('');
  const [openLoading, setOpenLoading] = useState(false);
  const [copying, setCopying] = useState(false);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await referencePresetApi.import(file);
      await onChanged();
    } catch (failure) {
      onError((failure as Error).message);
    }
  };

  const copyFromLibrary = async (presetId: string) => {
    if (!presetId || copying) return;
    setCopying(true);
    try {
      await referencePresetApi.copyFromLibrary(presetId);
      await onChanged();
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setCopying(false);
    }
  };

  const remove = async (id: string) => {
    if (confirmingDelete !== id) {
      setConfirmingDelete(id);
      return;
    }
    setConfirmingDelete(null);
    try {
      await referencePresetApi.remove(id);
      if (openId === id) setOpenId(null);
      await onChanged();
    } catch (failure) {
      onError((failure as Error).message);
    }
  };

  const toggleView = async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setOpenLoading(true);
    try {
      const record = await referencePresetApi.get(id);
      setOpenRaw(record.raw);
    } catch (failure) {
      setOpenId(null);
      onError((failure as Error).message);
    } finally {
      setOpenLoading(false);
    }
  };

  return (
    <section className="preset-cc-references">
      <div className="preset-cc-references__head">
        <h2>Reference presets</h2>
        <div className="preset-cc-references__actions">
          {/* A picker that acts on pick: the value never sticks, so the same preset can be
              copied again (it lands under a suffixed name). */}
          <Select
            label="Copy from my presets"
            value=""
            placeholder={copying ? 'Copying…' : 'Copy from my presets…'}
            disabled={copying || !presets.length}
            disabledReason={copying ? 'Copying…' : 'You have no library presets.'}
            placement="bottom-end"
            options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
            onChange={(presetId) => void copyFromLibrary(presetId)}
          />
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => fileInput.current?.click()}
          >
            <UploadIcon /> Import
          </button>
        </div>
      </div>
      <p className="wc-hint">
        Example presets for the Co-Creator assistant to study — import a file or copy one of your
        own presets. They never appear in your preset list, and copying leaves the original
        untouched.
      </p>
      {references.length ? (
        references.map((entry) => {
          const timestamp = formatTimestamp(new Date(entry.modified).toISOString());
          return (
            <article className="preset-cc-reference-row" key={entry.id}>
              <div className="preset-cc-reference-row__line">
                <button
                  type="button"
                  className="preset-cc-reference-row__open"
                  onClick={() => void toggleView(entry.id)}
                >
                  <strong>{entry.name}</strong>
                  {timestamp ? <span>{timestamp.short}</span> : null}
                </button>
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  onClick={() => void toggleView(entry.id)}
                >
                  {openId === entry.id ? 'Hide' : 'View'}
                </button>
                <button
                  type="button"
                  className="wc-button wc-button--danger"
                  onClick={() => void remove(entry.id)}
                >
                  {confirmingDelete === entry.id ? 'Delete?' : 'Delete'}
                </button>
              </div>
              {openId === entry.id ? (
                <pre className="preset-cc-reference-row__raw">
                  {openLoading ? 'Loading…' : openRaw}
                </pre>
              ) : null}
            </article>
          );
        })
      ) : (
        <div className="wc-empty">
          No reference presets yet — import a SillyTavern-format preset JSON or copy one of your own
          presets to give the assistant examples to study.
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json"
        className="wc-visually-hidden"
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </section>
  );
}
