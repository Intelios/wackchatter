import type { ReferencePresetSummary } from '@shared/types/preset-cocreator.ts';
import { useRef, useState } from 'react';
import { UploadIcon } from '../../layout/icons.tsx';
import { referencePresetApi } from '../../lib/api.ts';
import { formatTimestamp } from '../chat/formatDate.ts';

interface PresetReferencePanelProps {
  references: readonly ReferencePresetSummary[];
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
  onChanged,
  onError,
}: PresetReferencePanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openRaw, setOpenRaw] = useState('');
  const [openLoading, setOpenLoading] = useState(false);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await referencePresetApi.import(file);
      await onChanged();
    } catch (failure) {
      onError((failure as Error).message);
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
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon /> Import
        </button>
      </div>
      <p className="wc-hint">
        Example presets for the Co-Creator assistant to study — they never appear in your preset
        list.
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
          No reference presets yet — import a SillyTavern-format preset JSON to give the assistant
          examples to study.
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
