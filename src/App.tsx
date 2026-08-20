import { greetingTexts } from '@shared/chat/message.ts';
import type { Connection } from '@shared/providers/types.ts';
import { PROVIDERS } from '@shared/providers/types.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { ChatBackupSummary, Persona } from '@shared/types/chat.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type {
  DialogueColorOverride,
  DialogueColorSettings,
  QuickCommand,
  SettingsResponse,
} from '@shared/types/settings.ts';
import {
  activeConnection,
  type CoCreatorSettings,
  DEFAULT_COCREATOR,
  DEFAULT_DIALOGUE_COLORS,
  DEFAULT_GUIDANCE,
  DEFAULT_SUMMARY,
  type GuidanceSettings,
  type SummarySettings,
} from '@shared/types/settings.ts';
import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '@shared/types/worldinfo.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { CharacterEditor } from './features/character/CharacterEditor.tsx';
import { CharacterList } from './features/character/CharacterList.tsx';
import { ChatContext } from './features/chat/ChatContext.tsx';
import { ChatView } from './features/chat/ChatView.tsx';
import { useChat } from './features/chat/useChat.ts';
import { usePromptPreview } from './features/chat/usePromptPreview.ts';
import { CocreatorShell } from './features/cocreator/CocreatorShell.tsx';
import { LorePanel } from './features/lore/LorePanel.tsx';
import { useLorebooks } from './features/lore/useLorebooks.ts';
import { PersonaPanel } from './features/persona/PersonaPanel.tsx';
import { usePresetDraft } from './features/preset/usePresetDraft.ts';
import { resolveBackgroundUrl } from './features/settings/backgrounds.ts';
import { UserSettingsPanel } from './features/settings/UserSettingsPanel.tsx';
import { StartScreen } from './features/start/StartScreen.tsx';
import { StatsShell } from './features/stats/StatsShell.tsx';
import { StudioShell } from './features/studio/StudioShell.tsx';
import { SummaryPanel } from './features/summary/SummaryPanel.tsx';
import { AppShell, Panel } from './layout/AppShell.tsx';
import { LeftPanel } from './layout/LeftPanel.tsx';
import {
  LEFT_PANELS,
  type LeftPanelId,
  RIGHT_PANELS,
  type RightPanelId,
} from './layout/panels.tsx';
import {
  backupApi,
  characterApi,
  chatApi,
  lorebookApi,
  personaApi,
  presetApi,
  settingsApi,
} from './lib/api.ts';
import type { PersistenceControls } from './lib/autosave.ts';
import { useTokenizer } from './lib/useTokenizer.ts';

export function App() {
  const [view, setView] = useState<'app' | 'studio' | 'cocreator' | 'stats'>('app');
  /** The card the Co-Creator just produced, opened once on arrival in the Studio. */
  const [studioInitialAvatar, setStudioInitialAvatar] = useState<string | null>(null);
  const [leftPanel, setLeftPanel] = useState<LeftPanelId | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanelId | null>(null);

  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  /** Folder paths under data/characters, including empty ones. */
  const [folders, setFolders] = useState<string[]>([]);
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
  const [characterAvatarVersions, setCharacterAvatarVersions] = useState<Record<string, number>>(
    {},
  );
  const [personaAvatarVersions, setPersonaAvatarVersions] = useState<Record<string, number>>({});

  const [books, setBooks] = useState<LorebookSummary[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [backups, setBackups] = useState<ChatBackupSummary[]>([]);
  const characterPersistence = useRef<PersistenceControls | null>(null);
  const lorePersistence = useRef<PersistenceControls | null>(null);
  const personaPersistence = useRef<PersistenceControls | null>(null);
  const studioPersistence = useRef<PersistenceControls | null>(null);
  const cocreatorPersistence = useRef<PersistenceControls | null>(null);

  const flushRightPanel = useCallback(async () => {
    const controls = editing
      ? characterPersistence.current
      : rightPanel === 'lorebooks'
        ? lorePersistence.current
        : rightPanel === 'persona'
          ? personaPersistence.current
          : null;
    await controls?.flush();
  }, [editing, rightPanel]);

  /**
   * Reveal a right panel. Idempotent — never closes, so programmatic jumps (the chat
   * menu, opening a character) cannot toggle a panel shut by landing on the one you are
   * already looking at.
   */
  const showRightPanel = useCallback(
    async (id: RightPanelId) => {
      // The character editor replaces the panel outright, so without the `editing` check
      // the panel would change behind a screen nobody can see.
      if (id === rightPanel && !editing) return;
      try {
        await flushRightPanel();
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      setEditing(false);
      setRightPanel(id);
    },
    [editing, flushRightPanel, rightPanel],
  );

  /**
   * The bar buttons. Pressing the panel you are already on closes the side.
   *
   * Closing unmounts the panel, unlike the old collapse-in-place, so it has to flush like
   * a switch does — the panels' own unmount cleanups are fire-and-forget and swallow
   * errors, where this aborts and surfaces them.
   */
  const selectRightPanel = useCallback(
    async (id: RightPanelId) => {
      if (id !== rightPanel || editing) {
        await showRightPanel(id);
        return;
      }
      try {
        await flushRightPanel();
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      setRightPanel(null);
    },
    [editing, flushRightPanel, rightPanel, showRightPanel],
  );

  const selectLeftPanel = useCallback((id: LeftPanelId) => {
    // Nothing on the left autosaves — the preset saves explicitly and connection settings
    // write through immediately — so there is nothing to flush.
    setLeftPanel((current) => (current === id ? null : id));
  }, []);

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
      // Together, so the list never renders cards whose folder row has not arrived yet.
      const [nextCharacters, nextFolders] = await Promise.all([
        characterApi.list(),
        characterApi.folders.list(),
      ]);
      setCharacters(nextCharacters);
      setFolders(nextFolders);
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

  const connection = settings ? activeConnection(settings) : null;
  const summarySettings: SummarySettings = settings?.summary ?? DEFAULT_SUMMARY;
  const summaryConnection = summarySettings.connectionId
    ? (settings?.connections.find((entry) => entry.id === summarySettings.connectionId) ??
      connection)
    : connection;
  // Detail resolves asynchronously. Never let the previous card accompany a newly
  // selected avatar into useChat's auto-open effect.
  const character = detail?.avatar === selected ? detail.card.data : null;

  // Exact for GPT and o-series, an estimate elsewhere — the same position ST is in.
  const countTokens = useTokenizer(connection?.model ?? '', settings?.tokenizerEncoding);
  const summaryCountTokens = useTokenizer(
    summaryConnection?.model ?? '',
    settings?.tokenizerEncoding,
  );

  const coCreatorSettings: CoCreatorSettings = settings?.coCreator ?? DEFAULT_COCREATOR;

  const worldInfoSettings: WorldInfoSettings = settings?.worldInfo ?? DEFAULT_WI_SETTINGS;
  const guidanceSettings: GuidanceSettings = settings?.guidance ?? DEFAULT_GUIDANCE;
  const dialogueColorSettings: DialogueColorSettings =
    settings?.dialogueColors ?? DEFAULT_DIALOGUE_COLORS;
  // Normalised server-side; the fallbacks only cover the pre-load render.
  const characterRatings: Record<string, number> = settings?.characterRatings ?? {};
  const characterListSort: 'name' | 'rating' =
    settings?.characterListSort === 'rating' ? 'rating' : 'name';
  const hiddenTags = useMemo(
    () => (Array.isArray(settings?.hiddenTags) ? settings.hiddenTags : []),
    [settings?.hiddenTags],
  );
  // Normalised server-side; the fallback only covers the pre-load render.
  const quickCommands: QuickCommand[] = settings?.quickCommands ?? [];
  // Only the enabled ones ever leave here. A disabled script is inert either way, but
  // filtering once means neither the assembler nor the transcript walks past it per message.
  const regexScripts = useMemo(
    () => (settings?.regexScripts ?? []).filter((script) => !script.disabled),
    [settings?.regexScripts],
  );

  // Which character folders are shut. Round-trips through settings on every toggle, the same
  // way the default persona does — the write is a small local file and the list is short.
  const collapsedCharacterFolders = useMemo(
    () =>
      Array.isArray(settings?.collapsedCharacterFolders)
        ? (settings.collapsedCharacterFolders as string[])
        : [],
    [settings?.collapsedCharacterFolders],
  );

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

  /**
   * Write-through patch of the active connection, for the Generation panel's
   * provider-behaviour toggles. Connection settings save immediately — they are not
   * part of the preset draft. Goes through the per-connection endpoint, never a
   * wholesale array, so a stale snapshot here cannot drop another connection.
   */
  const patchActiveConnection = useCallback(
    (patch: Partial<Connection>) => {
      if (!settings) return;
      const active = activeConnection(settings);
      if (!active) return;
      settingsApi
        .patchConnection(active.id, patch)
        .then(setSettings)
        .catch((err) => setError((err as Error).message));
    },
    [settings],
  );

  const patchCharacterDialogueColor = useCallback(
    (avatar: string, value: DialogueColorOverride | undefined) => {
      if (!settings) return;
      const characters = { ...dialogueColorSettings.characters };
      if (value === undefined) delete characters[avatar];
      else characters[avatar] = value;
      void patchSettings({
        dialogueColors: { ...dialogueColorSettings, characters },
      });
    },
    [dialogueColorSettings, patchSettings, settings],
  );

  const patchPersonaDialogueColor = useCallback(
    (id: string, value: DialogueColorOverride | undefined) => {
      if (!settings) return;
      const personas = { ...dialogueColorSettings.personas };
      if (value === undefined) delete personas[id];
      else personas[id] = value;
      void patchSettings({
        dialogueColors: { ...dialogueColorSettings, personas },
      });
    },
    [dialogueColorSettings, patchSettings, settings],
  );

  const patchCharacterRating = useCallback(
    (avatar: string, value: number | undefined) => {
      if (!settings) return;
      const ratings = { ...characterRatings };
      if (value === undefined) delete ratings[avatar];
      else ratings[avatar] = value;
      void patchSettings({ characterRatings: ratings });
    },
    [characterRatings, patchSettings, settings],
  );

  const bumpCharacterAvatar = useCallback((avatar: string) => {
    setCharacterAvatarVersions((current) => ({ ...current, [avatar]: Date.now() }));
  }, []);

  const bumpPersonaAvatar = useCallback((id: string) => {
    setPersonaAvatarVersions((current) => ({ ...current, [id]: Date.now() }));
  }, []);

  const selectPreset = useCallback(
    (id: string) => {
      setPresetId(id);
      void patchSettings({ presetId: id });
    },
    [patchSettings],
  );

  /**
   * User Settings edits apply immediately and persist on a debounce.
   *
   * Dragging a blur slider at 60fps through `patchSettings` would issue ~60 atomic writes
   * a second, and worse, the value driving the CSS would be whatever the last round-trip
   * returned — so the image would visibly lag the thumb. The optimistic local update is
   * what makes the slider feel attached to the picture.
   */
  const userSettingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Merged, not replaced: nudging blur and then dim inside the debounce window must save
  // both. A plain "last patch wins" debounce would drop the blur.
  const userSettingsPending = useRef<Record<string, unknown>>({});

  const patchUserSettings = useCallback(
    (patch: Record<string, unknown>) => {
      setSettings((current) => (current ? { ...current, ...patch } : current));
      userSettingsPending.current = { ...userSettingsPending.current, ...patch };

      if (userSettingsTimer.current) clearTimeout(userSettingsTimer.current);
      userSettingsTimer.current = setTimeout(() => {
        const pending = userSettingsPending.current;
        userSettingsPending.current = {};
        void patchSettings(pending);
      }, 200);
    },
    [patchSettings],
  );

  useEffect(() => {
    return () => {
      if (userSettingsTimer.current) clearTimeout(userSettingsTimer.current);
      const pending = userSettingsPending.current;
      userSettingsPending.current = {};
      if (Object.keys(pending).length > 0) void patchSettings(pending);
    };
  }, [patchSettings]);

  // Hoisted above the left panel's router: all four left panels edit the same preset, and
  // a Save/Revert bar that unmounts when you switch panels would hide unsaved work.
  const presetDraft = usePresetDraft({
    presetId,
    preset,
    onPresetChange: setPreset,
    onSelectPreset: selectPreset,
    onPresetsChanged: refreshPresets,
    onRevertPreset: () => setPresetReload((n) => n + 1),
  });

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
    presetId,
    personas,
    personaId: settings?.personaId ?? null,
    onPersonaSwitch: (id) => void patchSettings({ personaId: id }),
    connection,
    countTokens,
    streamingFps: settings?.streamingFps ?? 30,
    worldInfoSources: lore.sources,
    resolveWorldInfoSources: lore.sourcesForPersona,
    worldInfoSettings,
    guidanceSettings,
    summaryConnection,
    summarySettings,
    summaryCountTokens,
    globalVariables: settings?.variables ?? {},
    regexScripts,
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
          guidanceSettings,
          summarySettings,
          globalVariables: settings?.variables ?? {},
          regexScripts,
        }
      : null,
  );

  const transitionToCharacter = useCallback(
    async (
      avatar: string,
      options?: { editing?: boolean; chatId?: string; panel?: RightPanelId | null },
    ) => {
      const editing = options?.editing ?? false;
      if (avatar !== selected || editing || options?.chatId !== undefined) {
        chat.abort();
        chat.cancelSummary();
        try {
          await chat.flushSaves();
        } catch {
          return;
        }
      }
      if (options?.chatId) chat.pendingChatRef.current = options.chatId;
      if (avatar !== selected) {
        setDetail(null);
        setSelected(avatar);
      }
      setEditing(editing);
      setRightPanel(options?.panel === undefined ? 'characters' : options.panel);
    },
    [chat, selected],
  );

  const handleSelect = useCallback(
    (avatar: string) => {
      void transitionToCharacter(avatar);
    },
    [transitionToCharacter],
  );

  const handleOpenRecentChat = useCallback(
    (avatar: string, chatId: string) => {
      void transitionToCharacter(avatar, { chatId, panel: null });
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
      chat.abort();
      chat.cancelSummary();
      await chat.flushSaves();
      await flushRightPanel();
    } catch {
      return;
    }
    setSelected(null);
    setDetail(null);
    setEditing(false);
    setRightPanel(null);
  }, [chat, flushRightPanel]);

  /**
   * The trash bin, across every character — it is shown in User Settings, which is not a
   * per-character place. Every delete, restore and purge touches it, so it is refetched
   * after each rather than kept in sync by hand.
   */
  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await backupApi.list());
    } catch {
      // Keep the last good list; a stale bin is better than a blank one.
    }
  }, []);

  useEffect(() => {
    void refreshBackups();
  }, [refreshBackups]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      try {
        await chat.deleteChat(id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        void refreshBackups();
      }
    },
    [chat, refreshBackups],
  );

  /**
   * Bring a deleted chat back and open it.
   *
   * The bin is reachable from the start screen now, where the restored chat's character is
   * usually not the open one — and may be no character at all. Restoring across that
   * boundary goes through the same door the recent-chat rows use, so the character is
   * selected and its panels reset exactly as if the chat had been opened normally.
   */
  const handleRestoreBackup = useCallback(
    async (backupId: string) => {
      try {
        const restored = await backupApi.restore(backupId);
        if (selected === restored.characterId) {
          await chat.refreshChats();
          void chat.openChat(restored.id);
        } else {
          void transitionToCharacter(restored.characterId, {
            chatId: restored.id,
            panel: null,
          });
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        void refreshBackups();
      }
    },
    [chat, selected, transitionToCharacter, refreshBackups],
  );

  /** Empty one slot of the bin for good. */
  const handlePurgeBackup = useCallback(
    async (backupId: string) => {
      try {
        await backupApi.remove(backupId);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        void refreshBackups();
      }
    },
    [refreshBackups],
  );

  /** Empty all slots of the bin for good. */
  const handlePurgeAllBackups = useCallback(async () => {
    try {
      await backupApi.removeAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      void refreshBackups();
    }
  }, [refreshBackups]);

  const handleImportChat = useCallback(
    async (file: File) => {
      if (!selected) return;
      try {
        const imported = await chatApi.import(file, selected);
        await chat.refreshChats();
        void chat.openChat(imported.id);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [selected, chat],
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
      const previousAvatar = selected;
      try {
        chat.abort();
        await chat.flushSaves();
      } catch {
        // The rename already landed; a failed chat flush is surfaced by the app shell and
        // should not stop the re-select.
      }
      setSelected(saved.avatar);
      setDetail(saved);
      if (previousAvatar) {
        setSettings((current) => {
          if (!current || !Object.hasOwn(current.dialogueColors.characters, previousAvatar)) {
            return current;
          }
          const characters = { ...current.dialogueColors.characters };
          const value = characters[previousAvatar]!;
          delete characters[previousAvatar];
          characters[saved.avatar] = value;
          return { ...current, dialogueColors: { ...current.dialogueColors, characters } };
        });
        setSettings((current) => {
          if (!current || !Object.hasOwn(current.characterRatings, previousAvatar)) {
            return current;
          }
          const ratings = { ...current.characterRatings };
          const value = ratings[previousAvatar]!;
          delete ratings[previousAvatar];
          ratings[saved.avatar] = value;
          return { ...current, characterRatings: ratings };
        });
        setCharacterAvatarVersions((current) => {
          if (!Object.hasOwn(current, previousAvatar)) return current;
          const next = { ...current, [saved.avatar]: current[previousAvatar]! };
          delete next[previousAvatar];
          return next;
        });
      }
      void refresh();
    },
    [chat, refresh, selected],
  );

  const handleDeleted = useCallback(() => {
    chat.abort();
    const deleted = selected;
    if (deleted) {
      setSettings((current) => {
        if (!current || !Object.hasOwn(current.dialogueColors.characters, deleted)) return current;
        const characters = { ...current.dialogueColors.characters };
        delete characters[deleted];
        return { ...current, dialogueColors: { ...current.dialogueColors, characters } };
      });
      setSettings((current) => {
        if (!current || !Object.hasOwn(current.characterRatings, deleted)) return current;
        const ratings = { ...current.characterRatings };
        delete ratings[deleted];
        return { ...current, characterRatings: ratings };
      });
      setCharacterAvatarVersions((current) => {
        if (!Object.hasOwn(current, deleted)) return current;
        const next = { ...current };
        delete next[deleted];
        return next;
      });
    }
    setSelected(null);
    setDetail(null);
    setEditing(false);
    void refresh();
  }, [chat, refresh, selected]);

  /** The Studio suspends the chat shell, so both sets of pending work must land first. */
  const enterStudio = useCallback(async () => {
    try {
      chat.abort();
      chat.cancelSummary();
      await chat.flushSaves();
      await flushRightPanel();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    // Entering by hand opens the library. Only the Co-Creator's handoff names a card, and a
    // handoff the user has already left must not be re-opened by a later, unrelated entry.
    setStudioInitialAvatar(null);
    setView('studio');
  }, [chat, flushRightPanel]);

  const exitStudio = useCallback(async () => {
    try {
      await studioPersistence.current?.flush();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    // Cleared, or entering the Studio again later would re-open the handed-off card.
    setStudioInitialAvatar(null);
    setView('app');
    void refresh();
  }, [refresh]);

  /** Same bargain as the Studio: it suspends the chat shell, so pending work lands first. */
  const enterCoCreator = useCallback(async () => {
    try {
      chat.abort();
      chat.cancelSummary();
      await chat.flushSaves();
      await flushRightPanel();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setView('cocreator');
  }, [chat, flushRightPanel]);

  /**
   * Finish: leave the Co-Creator for the Studio, on the card it just made.
   *
   * The desk has already flushed and created the card, so this only moves. Refreshing first
   * means the Studio's library — and the chat app behind it — know about the new card before
   * either renders.
   */
  const finishCoCreator = useCallback(
    (avatar: string) => {
      setStudioInitialAvatar(avatar);
      setView('studio');
      void refresh();
    },
    [refresh],
  );

  const exitCoCreator = useCallback(async () => {
    try {
      await cocreatorPersistence.current?.flush();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setView('app');
    void refresh();
  }, [refresh]);

  /**
   * Stats replaces the chat shell like its two siblings, so pending work lands first for
   * the same reason — except here it is also what makes the numbers right: a chat still
   * sitting in the save queue is a chat the server has not been told about yet.
   */
  const enterStats = useCallback(async () => {
    try {
      chat.abort();
      chat.cancelSummary();
      await chat.flushSaves();
      await flushRightPanel();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setView('stats');
  }, [chat, flushRightPanel]);

  /** Read-only throughout, so there is nothing of its own to flush on the way out. */
  const exitStats = useCallback(() => {
    setView('app');
  }, []);

  const handlePersonaDeleted = useCallback((id: string) => {
    setSettings((current) => {
      if (!current || !Object.hasOwn(current.dialogueColors.personas, id)) return current;
      const personas = { ...current.dialogueColors.personas };
      delete personas[id];
      return { ...current, dialogueColors: { ...current.dialogueColors, personas } };
    });
    setPersonaAvatarVersions((current) => {
      if (!Object.hasOwn(current, id)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  // One current persona: picking it sets the app-wide selection and, with a chat open,
  // switches this chat to it too. The two never drift.
  const handleSelectPersona = useCallback(
    (id: string | null) => {
      void patchSettings({ personaId: id });
      if (chat.state.chatId) chat.setPersona(id);
    },
    [chat, patchSettings],
  );

  const active = characters.find((c) => c.avatar === selected) ?? null;
  const showEditor = editing && detail?.avatar === selected ? detail : null;
  const ready = Boolean(connection?.baseUrl && connection.model && preset);

  /*
   * The tab, not the top bar.
   *
   * This used to label the middle of the top bar, where it was three kinds of redundant:
   * the character's name is on every bubble and in the composer's placeholder, the chat's
   * title is the literal default 'New chat' until someone renames it, and on the home
   * screen it read "WackChatter" directly above the wordmark. A permanent caption for
   * things you are already looking at, in an app whose chrome is otherwise built to get
   * out of the way of the background image.
   *
   * The tab is where the same string earns its keep: it tells windows, history and the
   * task switcher which chat this is, and it is nowhere near your eye while you read.
   *
   * The app's name is left to index.html's <title> as the no-chat fallback rather than
   * suffixed onto every chat, since a tab is too narrow to show both and the chat is the
   * half worth keeping.
   */
  const documentTitle = useMemo(() => {
    if (view === 'studio') return 'Character Creator Studio';
    if (view === 'cocreator') return 'Character Co-Creator';
    if (view === 'stats') return 'Stats';
    if (!active) return 'WackChatter';
    return chat.state.title ? `${active.name} — ${chat.state.title}` : active.name;
  }, [view, active, chat.state.title]);

  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  const studioInspectorCollapsed = settings?.studioInspectorCollapsed === true;

  if (view === 'stats') {
    return (
      <StatsShell
        characters={characters}
        personas={personas}
        backgroundUrl={resolveBackgroundUrl(settings?.background)}
        backgroundBlur={Number(settings?.backgroundBlur ?? 8)}
        backgroundDim={Number(settings?.backgroundDim ?? 0.55)}
        glass={settings?.glass !== false}
        onExit={exitStats}
      />
    );
  }

  if (view === 'cocreator') {
    return (
      <CocreatorShell
        defaults={coCreatorSettings}
        connections={settings?.connections ?? []}
        activeConnectionId={connection?.id ?? null}
        presets={presets}
        activePresetId={presetId}
        activePreset={preset}
        tokenizerEncoding={settings?.tokenizerEncoding}
        onDefaultsChange={(patch) => void patchSettings({ coCreator: patch })}
        characters={characters}
        streamingFps={Number(settings?.streamingFps ?? 30)}
        backgroundUrl={resolveBackgroundUrl(settings?.background)}
        backgroundBlur={Number(settings?.backgroundBlur ?? 8)}
        backgroundDim={Number(settings?.backgroundDim ?? 0.55)}
        glass={settings?.glass !== false}
        onExit={exitCoCreator}
        onFinished={finishCoCreator}
        registerPersistence={(controls) => {
          cocreatorPersistence.current = controls;
        }}
      />
    );
  }

  if (view === 'studio') {
    return (
      <StudioShell
        characters={characters}
        folders={folders}
        books={books}
        countTokens={countTokens}
        contextLimit={preset?.openai_max_context}
        backgroundUrl={resolveBackgroundUrl(settings?.background)}
        backgroundBlur={Number(settings?.backgroundBlur ?? 8)}
        backgroundDim={Number(settings?.backgroundDim ?? 0.55)}
        glass={settings?.glass !== false}
        inspectorCollapsed={studioInspectorCollapsed}
        onInspectorCollapsedChange={(collapsed) =>
          void patchSettings({ studioInspectorCollapsed: collapsed })
        }
        onExit={exitStudio}
        onOpenCoCreator={() => void enterCoCreator()}
        initialAvatar={studioInitialAvatar}
        registerPersistence={(controls) => {
          studioPersistence.current = controls;
        }}
      />
    );
  }

  return (
    <AppShell
      leftPanel={leftPanel}
      rightPanel={rightPanel}
      leftButtons={LEFT_PANELS}
      rightButtons={RIGHT_PANELS}
      onSelectLeft={selectLeftPanel}
      onSelectRight={(id) => void selectRightPanel(id)}
      backgroundUrl={resolveBackgroundUrl(settings?.background)}
      backgroundBlur={Number(settings?.backgroundBlur ?? 8)}
      backgroundDim={Number(settings?.backgroundDim ?? 0.55)}
      glass={settings?.glass !== false}
      /*
       * One boundary per region, under the root one in main.tsx.
       *
       * A crash is usually about what is on screen — a card with an odd field, a message
       * that will not render — so containing it to the region that owns that content
       * leaves the other two working, and `resetKeys` makes navigating away a recovery
       * path: switch panel, switch character, and the dead region comes back by itself
       * rather than waiting for a reload it may well survive.
       */
      left={
        <ErrorBoundary where="the left panel" resetKeys={[leftPanel]}>
          <LeftPanel
            active={leftPanel}
            settings={settings}
            onSettingsChange={setSettings}
            presets={presets}
            presetId={presetId}
            preset={preset}
            onSelectPreset={selectPreset}
            draft={presetDraft}
            tokenCounts={preview?.tokenCounts}
            macroWarnings={preview?.macroWarnings}
            extraSamplersSent={
              connection ? PROVIDERS[connection.provider].supportsExtraSamplers : false
            }
            connection={connection}
            onConnectionPatch={patchActiveConnection}
            // The last generation's result when there is one, else the live preview — so the
            // report answers "why didn't it fire?" before you send, too.
            worldInfo={chat.worldInfo ?? preview?.worldInfo ?? null}
            inspection={chat.inspection}
          />
        </ErrorBoundary>
      }
      right={
        <ErrorBoundary where="the right panel" resetKeys={[rightPanel, editing, selected]}>
          {showEditor ? (
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
                dialogueColor={dialogueColorSettings.characters[showEditor.avatar]}
                dialogueColorsEnabled={dialogueColorSettings.enabled}
                avatarVersion={characterAvatarVersions[showEditor.avatar]}
                rating={characterRatings[showEditor.avatar]}
                onRatingChange={(value) => patchCharacterRating(showEditor.avatar, value)}
                onDialogueColorChange={(value) =>
                  patchCharacterDialogueColor(showEditor.avatar, value)
                }
                onAvatarChanged={() => bumpCharacterAvatar(showEditor.avatar)}
              />
            </Panel>
          ) : (
            <Panel title={RIGHT_PANELS.find((p) => p.id === rightPanel)?.label}>
              {rightPanel === 'characters' ? (
                <>
                  {/* Scoped to the selected character, so it goes when nothing is open. */}
                  {selected ? (
                    <ChatContext
                      metadata={chat.state.metadata}
                      inheritedScenario={character?.scenario ?? ''}
                      onMetadataChange={chat.updateMetadata}
                    />
                  ) : null}
                  <CharacterList
                    characters={characters}
                    folders={folders}
                    collapsedFolders={collapsedCharacterFolders}
                    hiddenTags={hiddenTags}
                    ratings={characterRatings}
                    sort={characterListSort}
                    onSortChange={(sort) => void patchSettings({ characterListSort: sort })}
                    selected={selected}
                    loading={loading}
                    error={error}
                    onSelect={handleSelect}
                    onRefresh={refresh}
                    onEdit={(avatar) => void transitionToCharacter(avatar, { editing: true })}
                    onCollapsedFoldersChange={(next) =>
                      void patchSettings({ collapsedCharacterFolders: next })
                    }
                  />
                </>
              ) : null}

              {rightPanel === 'lorebooks' ? (
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

              {rightPanel === 'summary' ? (
                <SummaryPanel
                  chat={chat}
                  settings={summarySettings}
                  connections={settings?.connections ?? []}
                  activeConnection={connection}
                  summaryConnection={summaryConnection}
                  onSettingsChange={(patch) =>
                    void patchSettings({ summary: { ...summarySettings, ...patch } })
                  }
                />
              ) : null}

              {rightPanel === 'persona' ? (
                <PersonaPanel
                  personas={personas}
                  books={books}
                  activeId={settings?.personaId ?? null}
                  onSelect={handleSelectPersona}
                  onChanged={refreshPersonas}
                  registerPersistence={(controls) => {
                    personaPersistence.current = controls;
                  }}
                  dialogueColors={dialogueColorSettings}
                  avatarVersions={personaAvatarVersions}
                  onDialogueColorChange={patchPersonaDialogueColor}
                  onAvatarChanged={bumpPersonaAvatar}
                  onDeleted={handlePersonaDeleted}
                />
              ) : null}

              {rightPanel === 'settings' ? (
                <UserSettingsPanel
                  settings={settings}
                  onPatch={patchUserSettings}
                  unsavedPreset={presetDraft.dirty}
                  backups={backups}
                  characters={characters}
                  onRestoreBackup={(backupId) => void handleRestoreBackup(backupId)}
                  onPurgeBackup={(backupId) => void handlePurgeBackup(backupId)}
                  onPurgeAllBackups={() => void handlePurgeAllBackups()}
                />
              ) : null}
            </Panel>
          )}
        </ErrorBoundary>
      }
    >
      <ErrorBoundary where="the chat" resetKeys={[selected, chat.state.chatId]}>
        {active && character ? (
          <ChatView
            chat={chat}
            characterName={character.name || active.name}
            avatar={active.avatar}
            characterAvatarVersion={characterAvatarVersions[active.avatar]}
            personaAvatarVersions={personaAvatarVersions}
            creatorNotes={character?.creator_notes ?? ''}
            // From the card rather than the message's swipe count: re-rolling the opening
            // message appends swipes the creator never wrote, and counting those would slide
            // a scenario list out of step with the greetings it describes.
            greetingCount={character ? greetingTexts(character).length : 0}
            // The card, for the sheet on the character's avatar. Already loaded, so this
            // is the same object the transcript is rendering from.
            card={character}
            onEditCharacter={() => void transitionToCharacter(active.avatar, { editing: true })}
            ready={ready}
            onCloseChat={() => void handleCloseChat()}
            onOpenPanel={(id) => void showRightPanel(id)}
            guidance={guidanceSettings}
            onGuidanceChange={(patch) =>
              void patchSettings({ guidance: { ...guidanceSettings, ...patch } })
            }
            dialogueColors={dialogueColorSettings}
            quickCommands={quickCommands}
            onQuickCommandsChange={(next) => void patchSettings({ quickCommands: next })}
            onImportChat={(file) => void handleImportChat(file)}
            regexScripts={regexScripts}
          />
        ) : (
          <StartScreen
            characters={characters}
            onOpenChat={handleOpenRecentChat}
            onDeleteChat={handleDeleteChat}
            onOpenStudio={() => void enterStudio()}
            onOpenCoCreator={() => void enterCoCreator()}
            onOpenStats={() => void enterStats()}
          />
        )}
      </ErrorBoundary>
    </AppShell>
  );
}
