import { PROVIDERS } from '@shared/providers/types.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { SettingsResponse } from '@shared/types/settings.ts';
import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '@shared/types/worldinfo.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { PersistenceControls } from './lib/autosave.ts';
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
  const [presetReload, setPresetReload] = useState(0);

  const [settings, setSettings] = useState<SettingsResponse | null>(null);

  const [rightTab, setRightTab] = useState<RightTab>('characters');
  const [books, setBooks] = useState<LorebookSummary[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const characterPersistence = useRef<PersistenceControls | null>(null);
  const lorePersistence = useRef<PersistenceControls | null>(null);
  const personaPersistence = useRef<PersistenceControls | null>(null);

  const flushRightPanel = useCallback(async () => {
    const controls = editing
      ? characterPersistence.current
      : rightTab === 'lore'
        ? lorePersistence.current
        : rightTab === 'you'
          ? personaPersistence.current
          : null;
    await controls?.flush();
  }, [editing, rightTab]);

  const changeRightTab = useCallback(
    async (tab: RightTab) => {
      if (tab === rightTab && !editing) return;
      try {
        await flushRightPanel();
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      setEditing(false);
      setRightTab(tab);
    },
    [editing, flushRightPanel, rightTab],
  );

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

  const appliedStoredPreset = useRef(false);
  useEffect(() => {
    if (appliedStoredPreset.current || !settings || presets.length === 0) return;
    appliedStoredPreset.current = true;
    const stored = settings.presetId;
    if (stored && presets.some((p) => p.id === stored)) {
      setPresetId(stored);
    }
  }, [settings, presets]);

  // `presetReload` is not read in here — it is the reload trigger. Bumping it re-runs this
  // effect, which is how Revert discards the working copy: the file on disk is the only
  // authority on what the preset was, so we re-read it rather than snapshotting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: presetReload is the trigger
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
  }, [presetId, presetReload]);

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

  const selectPreset = useCallback(
    (id: string) => {
      setPresetId(id);
      void patchSettings({ presetId: id });
    },
    [patchSettings],
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

  /**
   * Leave the chat entirely, back to the no-character state.
   *
   * Flushed first, and a failed flush aborts — same rule as `transitionToCharacter`, and
   * for the same reason: navigating away from an unsaved chat drops the tail of the
   * transcript with nothing to show for it. Once `selected` is null `useChat` closes the
   * chat itself, so there is no further teardown here.
   */
  const handleCloseChat = useCallback(async () => {
    try {
      await chat.flushSaves();
      await flushRightPanel();
    } catch {
      return;
    }
    setSelected(null);
    setDetail(null);
    setEditing(false);
    // Land on the character list. Picking a character is the only thing left to do here,
    // and the Lore and You tabs both read as dead ends with no chat open.
    setRightTab('characters');
    setRightOpen(true);
  }, [chat, flushRightPanel]);

  /** Reveal one of the right panel's tools, for the chat menu's jump entries. */
  const openPanel = useCallback(
    async (tab: RightTab) => {
      // The character editor replaces the tabbed panel outright, so without this the tab
      // would change behind a screen nobody can see.
      await changeRightTab(tab);
      setRightOpen(true);
    },
    [changeRightTab],
  );

  const handleSaved = useCallback((saved: CharacterDetail) => {
    setDetail(saved);
    setCharacters((prev) => prev.map((c) => (c.avatar === saved.avatar ? { ...c, ...saved } : c)));
  }, []);

  /**
   * A rename changed the character's file identity. Re-select under the new avatar and
   * refresh the library so the old entry is replaced. Chat saves are flushed first so the
   * re-select (which reopens the character's most recent chat) cannot drop in-memory edits;
   * the chats themselves were carried over server-side by the rename.
   */
  const handleRenamed = useCallback(
    async (saved: CharacterDetail) => {
      try {
        await chat.flushSaves();
      } catch {
        // The rename already landed; a failed chat flush is surfaced by the app shell and
        // should not stop the re-select.
      }
      setSelected(saved.avatar);
      setDetail(saved);
      void refresh();
    },
    [chat, refresh],
  );

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
            onSelectPreset={selectPreset}
            onPresetChange={setPreset}
            onRevertPreset={() => setPresetReload((n) => n + 1)}
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
              onRenamed={(saved) => void handleRenamed(saved)}
              onDeleted={handleDeleted}
              onBack={() => setEditing(false)}
              registerPersistence={(controls) => {
                characterPersistence.current = controls;
              }}
            />
          </Panel>
        ) : (
          <Panel
            title="Library"
            tabs={
              <Tabs<RightTab>
                value={rightTab}
                options={RIGHT_TABS}
                onChange={(tab) => void changeRightTab(tab)}
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
                    creatorNotes={character?.creator_notes ?? ''}
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
                registerPersistence={(controls) => {
                  lorePersistence.current = controls;
                }}
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
                registerPersistence={(controls) => {
                  personaPersistence.current = controls;
                }}
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
          onCloseChat={() => void handleCloseChat()}
          onOpenPanel={openPanel}
        />
      ) : (
        <div className="wc-empty">
          <span>Select a character to begin.</span>
        </div>
      )}
    </AppShell>
  );
}
