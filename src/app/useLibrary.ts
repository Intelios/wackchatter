/**
 * What the library holds, as the shell lists it: characters and their folders, lorebooks,
 * personas, presets (and the one loaded for editing), and the avatar cache-busters.
 */

import type { CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { SettingsResponse } from '@shared/types/settings.ts';
import type { LorebookSummary } from '@shared/types/worldinfo.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { characterApi, lorebookApi, personaApi, presetApi } from '../lib/api.ts';

function without<T>(record: Record<string, T>, key: string, replacement?: string) {
  if (!Object.hasOwn(record, key)) return record;
  const next = { ...record };
  const value = next[key]!;
  delete next[key];
  if (replacement !== undefined) next[replacement] = value;
  return next;
}

export function useLibrary(options: {
  /** The stored preset choice, applied once both settings and the preset list have loaded. */
  settings: SettingsResponse | null;
  onPresetSelected: (id: string) => void;
  onError: (message: string) => void;
  /** A library refresh succeeded: the app-wide error it may have shown is over. */
  onRecovered: () => void;
}) {
  const { settings } = options;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const onRecoveredRef = useRef(options.onRecovered);
  onRecoveredRef.current = options.onRecovered;
  const fail = useCallback((err: unknown) => onErrorRef.current((err as Error).message), []);

  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  /** Folder paths under data/characters, including empty ones. */
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [books, setBooks] = useState<LorebookSummary[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);

  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [presetVersion, setPresetVersion] = useState<string | null>(null);
  const [presetReload, setPresetReload] = useState(0);

  const [characterAvatarVersions, setCharacterAvatarVersions] = useState<Record<string, number>>(
    {},
  );
  const [personaAvatarVersions, setPersonaAvatarVersions] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      // Together, so the list never renders cards whose folder row has not arrived yet.
      const [nextCharacters, nextFolders] = await Promise.all([
        characterApi.list(),
        characterApi.folders.list(),
      ]);
      setCharacters(nextCharacters);
      setFolders(nextFolders);
      onRecoveredRef.current();
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshBooks = useCallback(async () => {
    try {
      setBooks(await lorebookApi.list());
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  const refreshPersonas = useCallback(async () => {
    try {
      setPersonas(await personaApi.list());
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void refreshBooks();
    void refreshPersonas();
  }, [refreshBooks, refreshPersonas]);

  const refreshPresets = useCallback(async () => {
    try {
      const list = await presetApi.list();
      setPresets(list);
      // Fall back to the first preset whenever the current one disappears.
      setPresetId((current) =>
        current && list.some((p) => p.id === current) ? current : (list[0]?.id ?? null),
      );
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  const appliedStoredPreset = useRef(false);
  useEffect(() => {
    if (appliedStoredPreset.current || !settings || presets.length === 0) return;
    appliedStoredPreset.current = true;
    const stored = settings.presetId;
    if (stored && presets.some((p) => p.id === stored)) setPresetId(stored);
  }, [settings, presets]);

  // `presetReload` is not read in here — it is the reload trigger. Bumping it re-runs this
  // effect, which is how Revert discards the working copy: the file on disk is the only
  // authority on what the preset was, so we re-read it rather than snapshotting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: presetReload is the trigger
  useEffect(() => {
    if (!presetId) {
      setPreset(null);
      setPresetVersion(null);
      return;
    }
    let cancelled = false;
    presetApi
      .getVersioned(presetId)
      .then((loaded) => {
        if (!cancelled) {
          setPreset(loaded.preset);
          setPresetVersion(loaded.version);
        }
      })
      .catch((err) => {
        if (!cancelled) fail(err);
      });
    return () => {
      cancelled = true;
    };
  }, [presetId, presetReload, fail]);

  const { onPresetSelected } = options;
  const selectPreset = useCallback(
    (id: string) => {
      setPresetId(id);
      onPresetSelected(id);
    },
    [onPresetSelected],
  );

  /** Re-read the loaded preset from disk — Revert, or a newer version published elsewhere. */
  const reloadPreset = useCallback(() => setPresetReload((n) => n + 1), []);

  const bumpCharacterAvatar = useCallback((avatar: string) => {
    setCharacterAvatarVersions((current) => ({ ...current, [avatar]: Date.now() }));
  }, []);

  const bumpPersonaAvatar = useCallback((id: string) => {
    setPersonaAvatarVersions((current) => ({ ...current, [id]: Date.now() }));
  }, []);

  /** A card was renamed (`to`) or deleted (`to` undefined): its avatar version follows. */
  const followCharacterAvatar = useCallback((from: string, to?: string) => {
    setCharacterAvatarVersions((current) => without(current, from, to));
  }, []);

  const forgetPersonaAvatar = useCallback((id: string) => {
    setPersonaAvatarVersions((current) => without(current, id));
  }, []);

  return {
    characters,
    setCharacters,
    folders,
    loading,
    refresh,
    books,
    refreshBooks,
    personas,
    refreshPersonas,
    presets,
    presetId,
    preset,
    setPreset,
    presetVersion,
    setPresetVersion,
    refreshPresets,
    selectPreset,
    reloadPreset,
    characterAvatarVersions,
    personaAvatarVersions,
    bumpCharacterAvatar,
    bumpPersonaAvatar,
    followCharacterAvatar,
    forgetPersonaAvatar,
  };
}

export type Library = ReturnType<typeof useLibrary>;
