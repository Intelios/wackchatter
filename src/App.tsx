import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { SettingsResponse } from '@shared/types/settings.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CharacterEditor } from './features/character/CharacterEditor.tsx';
import { CharacterList } from './features/character/CharacterList.tsx';
import { ChatPicker } from './features/chat/ChatPicker.tsx';
import { ChatView } from './features/chat/ChatView.tsx';
import { PromptInspector } from './features/chat/PromptInspector.tsx';
import { useChat } from './features/chat/useChat.ts';
import { usePromptPreview } from './features/chat/usePromptPreview.ts';
import { ConnectionPanel } from './features/connection/ConnectionPanel.tsx';
import { SettingsPanel } from './features/preset/SettingsPanel.tsx';
import { AppShell, Panel } from './layout/AppShell.tsx';
import { characterApi, presetApi, settingsApi } from './lib/api.ts';
import { useTokenizer } from './lib/useTokenizer.ts';

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

  const [settings, setSettings] = useState<SettingsResponse | null>(null);

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
    settingsApi
      .get()
      .then(setSettings)
      .catch((err) => setError((err as Error).message));
  }, []);

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

  const connection = settings?.connection ?? null;
  const character = detail?.card.data ?? null;

  // Exact for GPT and o-series, an estimate elsewhere — the same position ST is in.
  const countTokens = useTokenizer(connection?.model ?? '', settings?.tokenizerEncoding);

  const chat = useChat({
    characterId: selected,
    character,
    preset,
    persona: null,
    connection,
    countTokens,
    streamingFps: settings?.streamingFps ?? 30,
  });

  // Live per-prompt token counts for the Prompt Manager.
  const preview = usePromptPreview(
    preset && character
      ? { preset, character, persona: null, messages: chat.messages, countTokens }
      : null,
  );

  const handleSelect = useCallback((avatar: string) => {
    setSelected(avatar);
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
  const ready = Boolean(connection?.baseUrl && connection.model && preset);

  const title = useMemo(() => {
    if (!active) return 'WackChatter';
    return chat.state.title ? `${active.name} — ${chat.state.title}` : active.name;
  }, [active, chat.state.title]);

  return (
    <AppShell
      leftOpen={leftOpen}
      rightOpen={rightOpen}
      onToggleLeft={() => setLeftOpen((v) => !v)}
      onToggleRight={() => setRightOpen((v) => !v)}
      title={title}
      left={
        <Panel title="Settings">
          <SettingsPanel
            presets={presets}
            presetId={presetId}
            preset={preset}
            onSelectPreset={setPresetId}
            onPresetChange={setPreset}
            onPresetsChanged={refreshPresets}
            tokenCounts={preview?.tokenCounts}
            connection={<ConnectionPanel settings={settings} onChange={setSettings} />}
            inspector={<PromptInspector inspection={chat.inspection} />}
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
            {selected ? (
              <ChatPicker
                chats={chat.chats}
                activeId={chat.state.chatId}
                title={chat.state.title}
                onOpen={(id) => void chat.openChat(id)}
                onNew={() => void chat.newChat()}
                onDelete={(id) => void chat.deleteChat(id)}
                onRename={chat.renameChat}
              />
            ) : null}
            <CharacterList
              characters={characters}
              selected={selected}
              loading={loading}
              error={error}
              onSelect={handleSelect}
              onRefresh={refresh}
              onEdit={(avatar) => {
                setSelected(avatar);
                setEditing(true);
              }}
            />
          </Panel>
        )
      }
    >
      {active && character ? (
        <ChatView
          chat={chat}
          characterName={character.name || active.name}
          avatar={active.avatar}
          ready={ready}
        />
      ) : (
        <div className="wc-empty">
          <span>Select a character to begin.</span>
        </div>
      )}
    </AppShell>
  );
}
