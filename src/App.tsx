import { PROVIDERS } from '@shared/providers/types.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { SettingsResponse } from '@shared/types/settings.ts';
import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '@shared/types/worldinfo.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tabs } from './components/Tabs.tsx';
import { CharacterEditor } from './features/character/CharacterEditor.tsx';
import { CharacterList } from './features/character/CharacterList.tsx';
import { ChatPicker } from './features/chat/ChatPicker.tsx';
import { ChatView } from './features/chat/ChatView.tsx';
import { PromptInspector } from './features/chat/PromptInspector.tsx';
import { WorldInfoReport } from './features/chat/WorldInfoReport.tsx';
import { useChat } from './features/chat/useChat.ts';
import { usePromptPreview } from './features/chat/usePromptPreview.ts';
import { ConnectionPanel } from './features/connection/ConnectionPanel.tsx';
import { LorePanel } from './features/lore/LorePanel.tsx';
import { useLorebooks } from './features/lore/useLorebooks.ts';
import { PersonaPanel } from './features/persona/PersonaPanel.tsx';
import { SettingsPanel } from './features/preset/SettingsPanel.tsx';
import { AppShell, Panel } from './layout/AppShell.tsx';
import { characterApi, lorebookApi, personaApi, presetApi, settingsApi } from './lib/api.ts';
import { useTokenizer } from './lib/useTokenizer.ts';

type RightTab = 'characters' | 'lore' | 'you';

const RIGHT_TABS = [
  { label: 'Characters', value: 'characters' as const },
  { label: 'Lore', value: 'lore' as const },
  { label: 'You', value: 'you' as const },
];

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

  const [rightTab, setRightTab] = useState<RightTab>('characters');
  const [books, setBooks] = useState<LorebookSummary[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);

  const refreshBooks = useCallback(async () => {
    try {
      setBooks(await lorebookApi.list());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshPersonas = useCallback(async () => {
    try {
      setPersonas(await personaApi.list());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

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
  // Detail resolves asynchronously. Never let the previous card accompany a newly
  // selected avatar into useChat's auto-open effect.
  const character = detail?.avatar === selected ? detail.card.data : null;

  // Exact for GPT and o-series, an estimate elsewhere — the same position ST is in.
  const countTokens = useTokenizer(connection?.model ?? '', settings?.tokenizerEncoding);

  const worldInfoSettings: WorldInfoSettings = settings?.worldInfo ?? DEFAULT_WI_SETTINGS;

  // Global books are opt-in per book; nothing is global until the user says so. Stored in
  // settings so the choice survives a reload.
  const globalBookIds = useMemo(
    () => (Array.isArray(settings?.globalLorebooks) ? (settings.globalLorebooks as string[]) : []),
    [settings?.globalLorebooks],
  );

  const saveSettingsStrict = useCallback(async (patch: Record<string, unknown>) => {
    try {
      setSettings(await settingsApi.save(patch));
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  }, []);

  const patchSettings = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await saveSettingsStrict(patch);
      } catch {
        // The error is already visible in the app shell. Ordinary UI autosaves are
        // fire-and-forget and must not create an unhandled rejected promise.
      }
    },
    [saveSettingsStrict],
  );

  const commitGlobalVariables = useCallback(
    async (variables: SettingsResponse['variables']) => {
      await saveSettingsStrict({ variables });
    },
    [saveSettingsStrict],
  );

  const personaLorebookIds = useMemo(
    () => personas.flatMap((persona) => (persona.lorebookId ? [persona.lorebookId] : [])),
    [personas],
  );
  const lore = useLorebooks({
    character,
    globalIds: globalBookIds,
    books,
    personaIds: personaLorebookIds,
  });

  const chat = useChat({
    characterId: selected,
    character,
    preset,
    personas,
    defaultPersonaId: settings?.personaId ?? null,
    connection,
    countTokens,
    streamingFps: settings?.streamingFps ?? 30,
    worldInfoSources: lore.sources,
    resolveWorldInfoSources: lore.sourcesForPersona,
    worldInfoSettings,
    globalVariables: settings?.variables ?? {},
    onGlobalVariablesChange: commitGlobalVariables,
  });

  const activeLoreSources = useMemo(
    () => lore.sourcesForPersona(chat.persona?.lorebookId ?? undefined),
    [lore.sourcesForPersona, chat.persona?.lorebookId],
  );

  // Live per-prompt token counts for the Prompt Manager. Uses the same resolved persona
  // as the send, so the preview cannot disagree with what actually ships.
  const preview = usePromptPreview(
    preset && character
      ? {
          preset,
          character,
          persona: chat.persona,
          messages: chat.messages,
          countTokens,
          worldInfoSources: activeLoreSources,
          worldInfoSettings,
          chatId: chat.state.chatId,
          chatMetadata: chat.state.metadata,
          globalVariables: settings?.variables ?? {},
        }
      : null,
  );

  const transitionToCharacter = useCallback(
    async (avatar: string, editing = false) => {
      if (avatar !== selected || editing) {
        try {
          await chat.flushSaves();
        } catch {
          return;
        }
      }
      if (avatar !== selected) {
        setDetail(null);
        setSelected(avatar);
      }
      setEditing(editing);
      setRightOpen(true);
    },
    [chat, selected],
  );

  const handleSelect = useCallback(
    (avatar: string) => {
      void transitionToCharacter(avatar);
    },
    [transitionToCharacter],
  );

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
  const showEditor = editing && detail?.avatar === selected ? detail : null;
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
            macroWarnings={preview?.macroWarnings}
            extraSamplersSent={
              connection ? PROVIDERS[connection.provider].supportsExtraSamplers : false
            }
            connection={<ConnectionPanel settings={settings} onChange={setSettings} />}
            // The last generation's result when there is one, else the live preview —
            // so the report answers "why didn't it fire?" before you send, too.
            worldInfoReport={
              <WorldInfoReport result={chat.worldInfo ?? preview?.worldInfo ?? null} />
            }
            inspector={<PromptInspector inspection={chat.inspection} />}
          />
        </Panel>
      }
      right={
        showEditor ? (
          <Panel title={showEditor.name || 'Character'}>
            <CharacterEditor
              key={showEditor.avatar}
              detail={showEditor}
              onSaved={handleSaved}
              onDeleted={handleDeleted}
              onBack={() => setEditing(false)}
            />
          </Panel>
        ) : (
          <Panel
            title="Library"
            tabs={
              <Tabs<RightTab>
                value={rightTab}
                options={RIGHT_TABS}
                onChange={setRightTab}
                label="Library section"
              />
            }
          >
            {rightTab === 'characters' ? (
              <>
                {/* The chat picker stays here: it is scoped to the selected character. */}
                {selected ? (
                  <ChatPicker
                    chats={chat.chats}
                    activeId={chat.state.chatId}
                    title={chat.state.title}
                    metadata={chat.state.metadata}
                    inheritedScenario={character?.scenario ?? ''}
                    onOpen={(id) => void chat.openChat(id)}
                    onNew={() => void chat.newChat()}
                    onDelete={(id) => void chat.deleteChat(id)}
                    onRename={chat.renameChat}
                    onMetadataChange={chat.updateMetadata}
                  />
                ) : null}
                <CharacterList
                  characters={characters}
                  selected={selected}
                  loading={loading}
                  error={error}
                  onSelect={handleSelect}
                  onRefresh={refresh}
                  onEdit={(avatar) => void transitionToCharacter(avatar, true)}
                />
              </>
            ) : null}

            {rightTab === 'lore' ? (
              <LorePanel
                books={books}
                settings={worldInfoSettings}
                onBooksChanged={() => {
                  void refreshBooks();
                  void refreshPersonas();
                }}
                onSettingsChange={(patch) => void patchSettings({ worldInfo: patch })}
                activeBooks={lore.activeForPersona(chat.persona?.lorebookId ?? undefined)}
                onBookEdited={lore.invalidate}
              />
            ) : null}

            {rightTab === 'you' ? (
              <PersonaPanel
                personas={personas}
                books={books}
                active={chat.persona}
                defaultId={settings?.personaId ?? null}
                hasChat={Boolean(chat.state.chatId)}
                onSelectForChat={chat.setPersona}
                onSelectDefault={(id) => void patchSettings({ personaId: id })}
                onChanged={refreshPersonas}
              />
            ) : null}
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
