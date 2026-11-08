/**
 * Everything the app knows and can do, with no markup.
 *
 * A shell renders from this and nothing else: today's (`LegacyShell`) and the 3.0 one,
 * which can replace it without re-deriving a line of state. Settings, the library and the
 * trash bin are hooks of their own; what stays here is what ties them together — which
 * character and chat are open, which area and panels are showing, and the navigation rule
 * every move between them follows: stop what is generating, land pending saves, and refuse
 * to move at all if a save fails.
 */

import type { CharacterDetail } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import { MAX_RECENT_PERSONAS } from '@shared/types/settings.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../features/chat/useChat.ts';
import { usePromptPreview } from '../features/chat/usePromptPreview.ts';
import { useLorebooks } from '../features/lore/useLorebooks.ts';
import { recentPersonaId, withRecentPersona } from '../features/persona/personaRoster.ts';
import { usePresetDraft } from '../features/preset/usePresetDraft.ts';
import type { LeftPanelId, RightPanelId } from '../layout/panels.tsx';
import { characterApi, chatApi } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { useAppSettings } from './useAppSettings.ts';
import { useBackups } from './useBackups.ts';
import { useLibrary } from './useLibrary.ts';

/** Which entries a book in the Lorebooks tool lists: all, or only the last reply's. */
export type LoreFilter = 'all' | 'fired' | 'skipped';

/**
 * The Lorebooks tool's page over its list: one book (by id, or `CARD_BOOK` from
 * `shell/lore.ts` for the open chat's card's own book), with an entry open in the editor or not.
 */
export interface LorePage {
  book: string;
  entry: number | null;
  filter: LoreFilter;
}

/** The Settings tool's chapters, in the order they are shown. */
export type SettingsChapter = 'connections' | 'look' | 'text' | 'library' | 'hood';

/**
 * Where the Settings tool is open: a chapter, and a setting to bring into view and light
 * up for a moment (the island's search opens straight onto one), or none.
 */
export interface SettingsPage {
  chapter: SettingsChapter;
  focus: string | null;
}

/** The Personas tool's page over its list. */
export type PersonaPage = { kind: 'edit'; id: string } | { kind: 'from' };
export type AppView = 'app' | 'studio' | 'cocreator' | 'tokentrail' | 'arena';
export type CoCreatorMode = 'landing' | 'character' | 'preset';

/** The autosaving editors a shell registers, so a navigation can land their work first. */
export type PersistenceKind = 'character' | 'lore' | 'persona' | 'studio' | 'cocreator';

/**
 * The settings write for a persona pick.
 *
 * It moves two things together — the app-wide persona, and the recents that order the
 * composer's switcher and the panel's roster. `withRecentPersona` returns the same reference
 * when nothing would move, so re-picking the persona you are already using writes no
 * settings at all.
 *
 * Recents are recorded at group grain — a variant's use bumps its base, because the Recent
 * section lists people and the base row is where its flavours are reached from. Switching
 * flavours of the same person then moves nothing, correctly.
 */
export function personaPickSettings(
  personas: readonly Persona[],
  recentIds: readonly string[],
  id: string | null,
) {
  const recent = withRecentPersona(
    recentIds,
    id ? recentPersonaId(personas, id) : null,
    MAX_RECENT_PERSONAS,
  );
  return recent === recentIds
    ? { personaId: id }
    : { personaId: id, recentPersonaIds: [...recent] };
}

export function useAppController() {
  const [view, setView] = useState<AppView>('app');
  const [coCreatorMode, setCoCreatorMode] = useState<CoCreatorMode>('landing');
  /** The card the Co-Creator just produced, opened once on arrival in the Studio. */
  const [studioInitialAvatar, setStudioInitialAvatar] = useState<string | null>(null);
  /** The card the Studio just handed off, seeded into a new session on arrival in the Co-Creator. */
  const [cocreatorSeedAvatar, setCocreatorSeedAvatar] = useState<string | null>(null);
  const [leftPanel, setLeftPanel] = useState<LeftPanelId | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanelId | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [editing, setEditing] = useState(false);
  /**
   * The character whose sheet the 3.0 Characters tool is showing, or null for the list. A
   * viewer, so unlike `editing` it never changes the open chat.
   */
  const [characterSheet, setCharacterSheet] = useState<string | null>(null);
  /**
   * What the 3.0 Personas tool shows over its list: one persona's editor, or the
   * from-a-character page. Null for the list. Here rather than in the tool because the
   * margin's heading names the open persona.
   */
  const [personaPage, setPersonaPage] = useState<PersonaPage | null>(null);
  /**
   * The prompt open in the 3.0 Preset tool's editor, by identifier, or null for none. Here
   * because the shell widens the margin while one is open.
   */
  const [presetPrompt, setPresetPrompt] = useState<string | null>(null);
  const [lorePage, setLorePage] = useState<LorePage | null>(null);
  /** The Memory tool's prompt editor is open: the shell widens the margin for it. */
  const [memoryPrompt, setMemoryPrompt] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  /** The app's one error line. The character list shows it; a good library refresh clears it. */
  const [error, setError] = useState<string | null>(null);
  const showError = useCallback((message: string) => setError(message), []);

  const persistence = useRef<Record<PersistenceKind, PersistenceControls | null>>({
    character: null,
    lore: null,
    persona: null,
    studio: null,
    cocreator: null,
  });
  const registerPersistence = useCallback(
    (kind: PersistenceKind) => (controls: PersistenceControls | null) => {
      persistence.current[kind] = controls;
    },
    [],
  );

  /*
   * Where the character list was scrolled to, so closing and reopening the panel lands where
   * you left it. Session-only by design: it is a browsing convenience, not library state, so
   * it never reaches settings.json.
   */
  const characterListScroll = useRef(0);

  const app = useAppSettings(showError);
  const { settings, view: prefs, models, patchSettings } = app;

  const library = useLibrary({
    settings,
    onPresetSelected: useCallback(
      (id: string) => void patchSettings({ presetId: id }),
      [patchSettings],
    ),
    onError: showError,
    onRecovered: useCallback(() => setError(null), []),
  });
  const { characters, personas, books, preset, presetId } = library;

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

  // Detail resolves asynchronously. Never let the previous card accompany a newly selected
  // avatar into useChat's auto-open effect.
  const character = detail?.avatar === selected ? detail.card.data : null;

  // Hoisted above the left panel's router: all four left panels edit the same preset, and a
  // Save/Revert bar that unmounts when you switch panels would hide unsaved work.
  const presetDraft = usePresetDraft({
    presetId,
    preset,
    presetVersion: library.presetVersion,
    onPresetChange: library.setPreset,
    onPresetVersionChange: library.setPresetVersion,
    onSelectPreset: library.selectPreset,
    onPresetsChanged: library.refreshPresets,
    onRevertPreset: library.reloadPreset,
  });

  const personaLorebookIds = useMemo(
    () => personas.flatMap((persona) => (persona.lorebookId ? [persona.lorebookId] : [])),
    [personas],
  );
  const lore = useLorebooks({
    character,
    globalIds: prefs.globalBookIds,
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
    connection: models.chat.model,
    countTokens: app.countTokens,
    streamingFps: settings?.streamingFps ?? 30,
    worldInfoSources: lore.sources,
    resolveWorldInfoSources: lore.sourcesForPersona,
    worldInfoSettings: prefs.worldInfo,
    guidanceSettings: prefs.guidance,
    summaryConnection: models.summary.model,
    summaryBlockedReason: models.summary.blockedReason,
    summarySettings: prefs.summary,
    summaryCountTokens: app.summaryCountTokens,
    memoryMode: prefs.memoryMode,
    nexusSettings: prefs.nexus,
    nexusConnection: models.nexus.model,
    nexusCountTokens: app.nexusCountTokens,
    globalVariables: settings?.variables ?? {},
    regexScripts: prefs.regexScripts,
    onGlobalVariablesChange: app.commitGlobalVariables,
  });

  const activeLoreSources = useMemo(
    () => lore.sourcesForPersona(chat.persona?.lorebookId ?? undefined),
    [lore.sourcesForPersona, chat.persona?.lorebookId],
  );

  // Live per-prompt token counts for the Prompt Manager. Uses the same resolved persona as
  // the send, so the preview cannot disagree with what actually ships.
  const preview = usePromptPreview(
    preset && character
      ? {
          preset,
          character,
          persona: chat.persona,
          messages: chat.messages,
          countTokens: app.countTokens,
          worldInfoSources: activeLoreSources,
          worldInfoSettings: prefs.worldInfo,
          chatId: chat.state.chatId,
          chatMetadata: chat.state.metadata,
          guidanceSettings: prefs.guidance,
          summarySettings: prefs.summary,
          memoryMode: chat.memoryMode,
          nexusSettings: prefs.nexus,
          prepareNexus: chat.nexus.preview,
          nexusVersion: chat.nexus.indexVersion,
          globalVariables: settings?.variables ?? {},
          regexScripts: prefs.regexScripts,
        }
      : null,
  );

  // --- Panels ----------------------------------------------------------------

  const flushRightPanel = useCallback(async () => {
    const controls = editing
      ? persistence.current.character
      : rightPanel === 'lorebooks'
        ? persistence.current.lore
        : rightPanel === 'persona'
          ? persistence.current.persona
          : null;
    await controls?.flush();
  }, [editing, rightPanel]);

  /**
   * Reveal a right panel. Idempotent — never closes, so programmatic jumps (the chat menu,
   * opening a character) cannot toggle a panel shut by landing on the one you are already
   * looking at.
   */
  const showRightPanel = useCallback(
    async (targetPanel: RightPanelId) => {
      // The character editor replaces the panel outright, so without the `editing` check the
      // panel would change behind a screen nobody can see.
      if (targetPanel === rightPanel && !editing) return;
      try {
        await flushRightPanel();
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      setEditing(false);
      setRightPanel(targetPanel);
    },
    [editing, flushRightPanel, rightPanel],
  );

  /**
   * The bar buttons. Pressing the panel you are already on closes the side.
   *
   * Closing unmounts the panel, unlike the old collapse-in-place, so it has to flush like a
   * switch does — the panels' own unmount cleanups are fire-and-forget and swallow errors,
   * where this aborts and surfaces them.
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

  // --- Characters and chats --------------------------------------------------

  const transitionToCharacter = useCallback(
    async (
      avatar: string,
      options?: { editing?: boolean; chatId?: string; panel?: RightPanelId | null },
    ) => {
      const nextEditing = options?.editing ?? false;
      if (avatar !== selected || nextEditing || options?.chatId !== undefined) {
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
      setEditing(nextEditing);
      setRightPanel(options?.panel === undefined ? 'characters' : options.panel);
    },
    [chat, selected],
  );

  const selectCharacter = useCallback(
    (avatar: string) => void transitionToCharacter(avatar),
    [transitionToCharacter],
  );

  const editCharacter = useCallback(
    (avatar: string) => void transitionToCharacter(avatar, { editing: true }),
    [transitionToCharacter],
  );

  const openRecentChat = useCallback(
    (avatar: string, chatId: string) => void transitionToCharacter(avatar, { chatId, panel: null }),
    [transitionToCharacter],
  );

  /**
   * Leave the chat entirely, back to the no-character state.
   *
   * Flushed first, and a failed flush aborts — same rule as `transitionToCharacter`, and for
   * the same reason: navigating away from an unsaved chat drops the tail of the transcript
   * with nothing to show for it. Once `selected` is null `useChat` closes the chat itself.
   *
   * The right panel is deliberately left as it was — closing a chat is not a reason to close
   * the character browser, so browsing survives hopping in and out of chats (same rule as
   * `characterDeleted`).
   */
  const closeChat = useCallback(async () => {
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
  }, [chat, flushRightPanel]);

  const backups = useBackups({
    chat,
    selected,
    openOnCharacter: openRecentChat,
    onError: showError,
  });

  const { setCharacters, refresh, followCharacterAvatar } = library;
  const { followCharacter } = app;

  const characterSaved = useCallback(
    (saved: CharacterDetail) => {
      setDetail(saved);
      setCharacters((prev) =>
        prev.map((c) => (c.avatar === saved.avatar ? { ...c, ...saved } : c)),
      );
    },
    [setCharacters],
  );

  /**
   * A rename changed the character's file identity. Re-select under the new avatar and
   * refresh the library so the old entry is replaced. Chat saves are flushed first so the
   * re-select (which reopens the character's most recent chat) cannot drop in-memory edits;
   * the chats themselves were carried over server-side by the rename.
   */
  const characterRenamed = useCallback(
    async (saved: CharacterDetail) => {
      const previousAvatar = selected;
      try {
        chat.abort();
        chat.cancelSummary();
        await chat.flushSaves();
      } catch {
        // The rename already landed; a failed chat flush is surfaced by the app shell and
        // should not stop the re-select.
      }
      setSelected(saved.avatar);
      setDetail(saved);
      if (previousAvatar) {
        followCharacter(previousAvatar, saved.avatar);
        followCharacterAvatar(previousAvatar, saved.avatar);
      }
      void refresh();
    },
    [chat, refresh, selected, followCharacter, followCharacterAvatar],
  );

  const characterDeleted = useCallback(() => {
    chat.abort();
    chat.cancelSummary();
    if (selected) {
      followCharacter(selected, null);
      followCharacterAvatar(selected);
    }
    setSelected(null);
    setDetail(null);
    setEditing(false);
    void refresh();
  }, [chat, refresh, selected, followCharacter, followCharacterAvatar]);

  // --- Personas --------------------------------------------------------------

  const { forgetPersona } = app;
  const { forgetPersonaAvatar } = library;
  const personaDeleted = useCallback(
    (id: string) => {
      forgetPersona(id);
      forgetPersonaAvatar(id);
    },
    [forgetPersona, forgetPersonaAvatar],
  );

  // One current persona: picking it sets the app-wide selection and, with a chat open,
  // switches this chat to it too. The two never drift.
  const selectPersona = useCallback(
    (id: string | null) => {
      void patchSettings(personaPickSettings(personas, settings?.recentPersonaIds ?? [], id));
      if (chat.state.chatId) chat.setPersona(id);
    },
    [chat, patchSettings, personas, settings?.recentPersonaIds],
  );

  // --- Areas -----------------------------------------------------------------

  /**
   * Leave the chat shell for an area that suspends it: stop what is generating, and land the
   * chat's and the open panel's pending saves. False, with the error shown, when a save
   * failed and the move must not happen.
   */
  const suspendChat = useCallback(
    async (stopGeneration = true) => {
      try {
        if (stopGeneration) {
          chat.abort();
          chat.cancelSummary();
        }
        await chat.flushSaves();
        await flushRightPanel();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [chat, flushRightPanel],
  );

  /** Land an area's own editor before leaving it. False, with the error shown, on failure. */
  const flushArea = useCallback(async (kind: 'studio' | 'cocreator') => {
    try {
      await persistence.current[kind]?.flush();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, []);

  const enterStudio = useCallback(async () => {
    if (!(await suspendChat())) return;
    // Entering by hand opens the library. Only the Co-Creator's handoff names a card, and a
    // handoff the user has already left must not be re-opened by a later, unrelated entry.
    setStudioInitialAvatar(null);
    setView('studio');
  }, [suspendChat]);

  /** Into the Studio on one card, the way the Co-Creator's Finish arrives there. */
  const enterStudioOn = useCallback(
    async (avatar: string) => {
      if (!(await suspendChat())) return;
      setStudioInitialAvatar(avatar);
      setView('studio');
    },
    [suspendChat],
  );

  const exitStudio = useCallback(async () => {
    if (!(await flushArea('studio'))) return;
    // Cleared, or entering the Studio again later would re-open the handed-off card.
    setStudioInitialAvatar(null);
    setView('app');
    void refresh();
  }, [flushArea, refresh]);

  /** Opens the Co-Creator: its landing, or straight into the Preset Co-Creator's sessions. */
  const enterCoCreator = useCallback(
    async (mode: 'landing' | 'preset' = 'landing') => {
      if (!(await suspendChat())) return;
      // Entering by hand opens the sessions list. Only the Studio's handoff names a card, and
      // one the user has already left behind must not seed a later, unrelated entry.
      setCocreatorSeedAvatar(null);
      setCoCreatorMode(mode);
      setView('cocreator');
    },
    [suspendChat],
  );

  /**
   * The Studio's half of the handoff: leave for the Co-Creator, seeded on the open card. The
   * Co-Creator reads the card from disk on the far side, so what it seeds from is what this
   * flush just landed.
   */
  const enterCoCreatorFromStudio = useCallback(
    async (avatar: string) => {
      if (!(await flushArea('studio'))) return;
      setCocreatorSeedAvatar(avatar);
      setCoCreatorMode('character');
      setView('cocreator');
    },
    [flushArea],
  );

  /** Back from a Co-Creator desk to its landing, once the desk's saves have landed. */
  const leaveCocreatorDesk = useCallback(async () => {
    if (!(await flushArea('cocreator'))) return;
    setCocreatorSeedAvatar(null);
    setCoCreatorMode('landing');
  }, [flushArea]);

  /**
   * Finish: leave the Co-Creator for the Studio, on the card it just made. The desk has
   * already flushed and created the card, so this only moves; refreshing first means the
   * Studio's library knows about the new card before it renders.
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
    if (!(await flushArea('cocreator'))) return;
    // Cleared, or entering the Co-Creator again later would seed from the handed-off card.
    setCocreatorSeedAvatar(null);
    setCoCreatorMode('landing');
    setView('app');
    void refresh();
  }, [flushArea, refresh]);

  /**
   * Publish saved changes before opening TokenTrail. The generation hooks stay mounted:
   * visiting Stats must not cancel an in-flight generation.
   */
  const enterStats = useCallback(async () => {
    if (!(await suspendChat(false))) return;
    setView('tokentrail');
  }, [suspendChat]);

  /** Read-only throughout, so there is nothing of its own to flush on the way out. */
  const exitStats = useCallback(() => setView('app'), []);

  const enterArena = useCallback(async () => {
    if (!(await suspendChat())) return;
    setView('arena');
  }, [suspendChat]);

  /*
   * Nothing of its own to flush either. The run log is session work, and a blind verdict is
   * written the moment it is cast — so unlike the two creator areas there is no queue that
   * could still be holding something on the way out.
   */
  const exitArena = useCallback(() => setView('app'), []);

  /** The Preset Co-Creator published a preset; if it is the one loaded and clean, reload it. */
  const { refreshPresets, setPresetVersion, reloadPreset } = library;
  const presetPublished = useCallback(
    (publishedId: string, version: string) => {
      void refreshPresets();
      if (publishedId === presetId && !presetDraft.dirty) {
        setPresetVersion(version);
        reloadPreset();
      }
    },
    [refreshPresets, presetId, presetDraft.dirty, setPresetVersion, reloadPreset],
  );

  // --- TokenTrail handoff ------------------------------------------------------

  const handoffStarted = useRef(false);
  useEffect(() => {
    if (handoffStarted.current || !settings || library.loading) return;
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('ttLibrary');
    if (!linked) return;
    handoffStarted.current = true;
    void (async () => {
      try {
        const response = await fetch('/api/integration');
        if (!response.ok) throw new Error('Could not verify WackChatter library.');
        const identity = (await response.json()) as { libraryId: string };
        if (identity.libraryId !== linked)
          throw new Error('This link belongs to another WackChatter library.');
        const id = params.get('ttChat');
        const avatar = params.get('ttCharacter');
        if (id) {
          const target = await chatApi.get(id);
          if (!characters.some((c) => c.avatar === target.characterId))
            throw new Error('This character is no longer in the library.');
          await transitionToCharacter(target.characterId, { chatId: id, panel: null });
        } else if (avatar) {
          if (!characters.some((c) => c.avatar === avatar))
            throw new Error('This character is no longer in the library.');
          await chat.flushSaves();
          await flushRightPanel();
          setStudioInitialAvatar(avatar);
          setView('studio');
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        const url = new URL(window.location.href);
        for (const key of ['ttLibrary', 'ttChat', 'ttCharacter']) url.searchParams.delete(key);
        window.history.replaceState(null, '', url);
      }
    })();
  }, [settings, library.loading, characters, transitionToCharacter, chat, flushRightPanel]);

  // --- What is showing ---------------------------------------------------------

  const active = characters.find((c) => c.avatar === selected) ?? null;
  const showEditor = editing && detail?.avatar === selected ? detail : null;
  const ready = Boolean(models.chat.model && preset);

  /*
   * The tab, not the top bar: it tells windows, history and the task switcher which chat this
   * is, and it is nowhere near your eye while you read. The app's name is left to
   * index.html's <title> as the no-chat fallback rather than suffixed onto every chat, since
   * a tab is too narrow to show both and the chat is the half worth keeping.
   */
  const documentTitle = useMemo(() => {
    if (view === 'studio') return 'Character Creator Studio';
    if (view === 'cocreator') {
      if (coCreatorMode === 'character') return 'Character Co-Creator';
      if (coCreatorMode === 'preset') return 'Preset Co-Creator';
      return 'Co-Creator';
    }
    if (view === 'tokentrail') return 'Stats in TokenTrail';
    if (view === 'arena') return 'Model Arena';
    if (!active) return 'WackChatter';
    return chat.state.title ? `${active.name} — ${chat.state.title}` : active.name;
  }, [view, coCreatorMode, active, chat.state.title]);

  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  return {
    /** Settings, their defaults filled in, the resolved model slots and every settings write. */
    app,
    library,
    backups,
    chat,
    lore,
    preview,
    presetDraft,

    view,
    coCreatorMode,
    setCoCreatorMode,
    studioInitialAvatar,
    cocreatorSeedAvatar,
    leftPanel,
    rightPanel,
    selected,
    active,
    character,
    showEditor,
    editing,
    setEditing,
    characterSheet,
    setCharacterSheet,
    personaPage,
    setPersonaPage,
    presetPrompt,
    setPresetPrompt,
    memoryPrompt,
    setMemoryPrompt,
    lorePage,
    setLorePage,
    settingsPage,
    setSettingsPage,
    ready,
    error,
    showError,
    characterListScroll,
    registerPersistence,

    selectLeftPanel,
    selectRightPanel,
    showRightPanel,
    selectCharacter,
    editCharacter,
    openRecentChat,
    closeChat,
    characterSaved,
    characterRenamed,
    characterDeleted,
    personaDeleted,
    selectPersona,
    enterStudio,
    enterStudioOn,
    exitStudio,
    enterCoCreator,
    enterCoCreatorFromStudio,
    leaveCocreatorDesk,
    finishCoCreator,
    exitCoCreator,
    enterStats,
    exitStats,
    enterArena,
    exitArena,
    presetPublished,
  };
}

export type AppController = ReturnType<typeof useAppController>;
