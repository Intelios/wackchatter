/**
 * The working copy of the active preset, and everything that decides what may be done to
 * it while there are unsaved edits.
 *
 * This lives above the left panel's router rather than inside a panel, because the left
 * side is now four panels that all edit the same preset. If `dirty` lived in one of them,
 * editing a sampler and then clicking Connection would unmount the Save/Revert bar: the
 * edits would still be sitting in App's `preset` state, but the only affordance for
 * saving them would be gone and the app would look saved. Losing work silently is worse
 * than losing it loudly.
 */

import type { Preset } from '@shared/types/preset.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { presetApi } from '../../lib/api.ts';

interface UsePresetDraftOptions {
  presetId: string | null;
  preset: Preset | null;
  onPresetChange: (preset: Preset) => void;
  onSelectPreset: (id: string) => void;
  onPresetsChanged: () => void;
  /** Re-read the preset from disk, discarding the working copy. */
  onRevertPreset: () => void;
}

export interface PresetDraft {
  /**
   * Unsaved edits to the working copy.
   *
   * Presets used to autosave on a debounce, which meant there was no way back from a
   * tweak you disliked — the original was already overwritten. Saving is explicit now,
   * and `dirty` is what Save, Revert and the switch guard all key off.
   */
  dirty: boolean;
  status: string;
  renaming: boolean;
  nameDraft: string;
  setNameDraft: (value: string) => void;
  startRename: () => void;
  cancelRename: () => void;
  change: (next: Preset) => void;
  setField: (key: keyof Preset, value: unknown) => void;
  save: () => Promise<void>;
  revert: () => void;
  rename: (next: string) => Promise<void>;
  importPreset: (file: File | undefined) => Promise<void>;
}

export function usePresetDraft({
  presetId,
  preset,
  onPresetChange,
  onSelectPreset,
  onPresetsChanged,
  onRevertPreset,
}: UsePresetDraftOptions): PresetDraft {
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  /**
   * The last preset object this hook produced.
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

  const change = useCallback(
    (next: Preset) => {
      ownEdit.current = next;
      setDirty(true);
      setStatus('');
      onPresetChange(next);
    },
    [onPresetChange],
  );

  const setField = useCallback(
    (key: keyof Preset, value: unknown) => {
      if (!preset) return;
      change({ ...preset, [key]: value });
    },
    [change, preset],
  );

  const save = useCallback(async () => {
    if (!preset || !presetId) return;
    try {
      await presetApi.save(presetId, preset);
      setDirty(false);
      setStatus('Saved');
    } catch (err) {
      setStatus((err as Error).message);
    }
  }, [preset, presetId]);

  const rename = useCallback(
    async (next: string) => {
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
    },
    [onPresetsChanged, onSelectPreset, presetId],
  );

  const importPreset = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const imported = await presetApi.import(file);
        onPresetsChanged();
        onSelectPreset(imported.id);
        setStatus(`Imported as “${imported.id}”`);
      } catch (err) {
        setStatus((err as Error).message);
      }
    },
    [onPresetsChanged, onSelectPreset],
  );

  const startRename = useCallback(() => {
    setNameDraft(presetId ?? '');
    setRenaming(true);
  }, [presetId]);

  return {
    dirty,
    status,
    renaming,
    nameDraft,
    setNameDraft,
    startRename,
    cancelRename: useCallback(() => setRenaming(false), []),
    change,
    setField,
    save,
    revert: onRevertPreset,
    rename,
    importPreset,
  };
}
