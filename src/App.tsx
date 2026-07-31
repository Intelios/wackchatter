import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import { useCallback, useEffect, useState } from 'react';
import { CharacterEditor } from './features/character/CharacterEditor.tsx';
import { CharacterList } from './features/character/CharacterList.tsx';
import { SettingsPanel } from './features/preset/SettingsPanel.tsx';
import { AppShell, Panel } from './layout/AppShell.tsx';
import { characterApi, presetApi } from './lib/api.ts';

export function App() {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);

  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);

  const refreshPresets = useCallback(async () => {
    try {
      const list = await presetApi.list();
      setPresets(list);
      // Fall back to the first preset whenever the current one disappears.
      setPresetId((current) =>
        current && list.some((p) => p.id === current) ? current : (list[0]?.id ?? null),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  useEffect(() => {
    if (!presetId) {
      setPreset(null);
      return;
    }

    let cancelled = false;
    presetApi
      .get(presetId)
      .then((loaded) => {
        if (!cancelled) setPreset(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [presetId]);

  const refresh = useCallback(async () => {
    try {
      setCharacters(await characterApi.list());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load the full card whenever the selection changes.
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    characterApi
      .get(selected)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const handleSelect = useCallback((avatar: string) => {
    setSelected(avatar);
    setEditing(true);
    setRightOpen(true);
  }, []);

  const handleSaved = useCallback((saved: CharacterDetail) => {
    setDetail(saved);
    setCharacters((prev) => prev.map((c) => (c.avatar === saved.avatar ? { ...c, ...saved } : c)));
  }, []);

  const handleDeleted = useCallback(() => {
    setSelected(null);
    setDetail(null);
    setEditing(false);
    void refresh();
  }, [refresh]);

  const active = characters.find((c) => c.avatar === selected) ?? null;
  const showEditor = editing && detail;

  return (
    <AppShell
      leftOpen={leftOpen}
      rightOpen={rightOpen}
      onToggleLeft={() => setLeftOpen((v) => !v)}
      onToggleRight={() => setRightOpen((v) => !v)}
      title={active?.name ?? 'WackChatter'}
      left={
        <Panel title="Settings">
          <SettingsPanel
            presets={presets}
            presetId={presetId}
            preset={preset}
            onSelectPreset={setPresetId}
            onPresetChange={setPreset}
            onPresetsChanged={refreshPresets}
          />
        </Panel>
      }
      right={
        showEditor ? (
          <Panel title={detail.name || 'Character'}>
            <CharacterEditor
              key={detail.avatar}
              detail={detail}
              onSaved={handleSaved}
              onDeleted={handleDeleted}
              onBack={() => setEditing(false)}
            />
          </Panel>
        ) : (
          <Panel title="Characters">
            <CharacterList
              characters={characters}
              selected={selected}
              loading={loading}
              error={error}
              onSelect={handleSelect}
              onRefresh={refresh}
            />
          </Panel>
        )
      }
    >
      {active ? (
        <div className="wc-empty">
          <strong>{active.name}</strong>
          <span>Chat arrives once the assembly engine is wired up.</span>
        </div>
      ) : (
        <div className="wc-empty">
          <span>Select a character to begin.</span>
        </div>
      )}
    </AppShell>
  );
}
