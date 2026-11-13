/**
 * The 3.0 home screen: a cover for the chat you were last in.
 *
 * The last chat's character is the headline, their portrait runs full-bleed behind it, the
 * cover line is the chat's name (or when you left it, in words) and their last reply is the
 * pull-quote. The rest of your recents stand in a stack of names on the right, each in its
 * character's colour; hovering one (or walking it with ↑/↓) re-covers the page and re-tints
 * the app. Enter continues. Scrolling down leaves for Create and Arena.
 *
 * The same cover serves the edges: a library with characters but no chats lists the cast
 * and quotes their greetings, an empty one welcomes you in the app's own lime, and a
 * library the server refused says why in place of everything else.
 */

import '@fontsource-variable/bodoni-moda/opsz-italic.css';
import '@fontsource-variable/martian-mono/index.css';
import './home.css';

import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary } from '@shared/types/chat.ts';
import {
  type CSSProperties,
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AppController, ToolId } from '../app/useAppController.ts';
import { Backdrop } from '../components/Backdrop.tsx';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import {
  cachedAvatarPalette,
  needsPortrait,
  type PortraitPalette,
  peekAvatarPalette,
  resolveSpeakerColors,
  useAvatarPalette,
} from '../features/chat/avatarColor.ts';
import { ModelsProvider } from '../features/models/ModelsContext.tsx';
import { characterApi, chatApi, personaApi, type VersionInfo, versionApi } from '../lib/api.ts';
import type { AuraInput } from './aura.ts';
import { useArm } from './controls.tsx';
import {
  agoInWords,
  isNamedChat,
  quoteOf,
  STACK_SIZE,
  splitName,
  stepStack,
  whenInWords,
} from './home.ts';
import { Island, type IslandMode, type IslandNotice, WingButton } from './Island.tsx';
import { PersonaPane, RestPane, type SearchItem, SearchPane } from './IslandPanes.tsx';
import { Icon } from './icons.tsx';
import { MarginTool, TOOLS, ToolHeading, toolSubtitle } from './MarginTools.tsx';
import { buildSearchItems } from './search.ts';
import { initialAuraStyle, useAura } from './useAura.ts';

/** The wings at home: everything that does not need a chat open. */
const HOME_LEFT: ToolId[] = ['characters', 'lorebooks', 'personas'];
const HOME_RIGHT: ToolId[] = ['preset', 'settings'];
const HOME_TOOLS: readonly ToolId[] = [...HOME_LEFT, ...HOME_RIGHT];

/** The app's own colour, for a library with nobody in it yet and for Create | Arena. */
const LIME = '#c2ee4a';

/** How long a name must stay under the mouse before the cover turns to it. */
const SETTLE_MS = 110;

type Screen = 'loading' | 'home' | 'cast' | 'empty' | 'refused';

/** One thing the cover can show: a recent chat, or (on first boot) a character. */
interface Entry {
  key: string;
  avatar: string;
  name: string;
  chatId: string | null;
  /** The chat's own name, when someone gave it one. */
  title: string | null;
  modified: number;
  messageCount: number;
  /** Their last reply, or their greeting when there is no chat yet. */
  reply: string;
}

export function HomeShell({ controller }: { controller: AppController }) {
  const { app, library } = controller;
  const { settings, view: prefs, models } = app;

  const rootRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const [recent, setRecent] = useState<ChatSummary[] | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  /** Which name in the stack the cover shows; 0 is the chat you were last in. */
  const [picked, setPicked] = useState(0);
  /*
   * The margin survives arriving here, except a tool that needs the open chat (memory,
   * inspect) — home has no wing for one of those. It closes for real rather than just
   * hiding, or it would spring back open on the next chat.
   */
  const { tool: routedTool, setTool } = controller;
  const tool = routedTool && HOME_TOOLS.includes(routedTool) ? routedTool : null;
  useEffect(() => {
    if (routedTool && !HOME_TOOLS.includes(routedTool)) setTool(null);
  }, [routedTool, setTool]);
  const [opened, setOpened] = useState<IslandMode | null>(null);
  const [notice, setNotice] = useState<IslandNotice | null>(null);
  const [onApps, setOnApps] = useState(false);
  const noticeId = useRef(0);
  const say = useCallback((next: Omit<IslandNotice, 'id'>) => {
    noticeId.current += 1;
    setNotice({ ...next, id: noticeId.current });
    return noticeId.current;
  }, []);

  // The Preset tool is reachable from home too, so a refused model save reports here rather
  // than surfacing as a stale notice the next time a chat opens.
  const modelSaveNotice = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (app.chatModelError) {
      modelSaveNotice.current = say({
        icon: 'alert',
        title: app.chatModelError.title,
        text: app.chatModelError.message,
        tone: 'bad',
        sticky: true,
      });
    } else if (modelSaveNotice.current !== undefined) {
      const id = modelSaveNotice.current;
      setNotice((current) => (current?.id === id ? null : current));
      modelSaveNotice.current = undefined;
    }
  }, [app.chatModelError, say]);

  // Recents load once, and again when the library changes under us (an import, a rename).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the library changing is the trigger
  useEffect(() => {
    let live = true;
    chatApi
      .recent(STACK_SIZE + 1)
      .then((list) => live && setRecent(list))
      .catch(() => live && setRecent([]));
    return () => {
      live = false;
    };
  }, [library.characters]);

  // The version can sit on screen for days; a returning window refetches it.
  useEffect(() => {
    let live = true;
    const load = () =>
      void versionApi
        .get()
        .then((info) => live && setVersion(info))
        .catch(() => {});
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // --- What the cover shows ---------------------------------------------------------------

  const byAvatar = useMemo(
    () => new Map(library.characters.map((summary) => [summary.avatar, summary])),
    [library.characters],
  );

  const refused = !settings && controller.error ? controller.error : null;
  const fromChats = useMemo<Entry[]>(
    () =>
      (recent ?? []).flatMap((summary) => {
        const character = byAvatar.get(summary.characterId);
        if (!character) return [];
        return [
          {
            key: `chat:${summary.id}`,
            avatar: summary.characterId,
            name: character.name,
            chatId: summary.id,
            title: isNamedChat(summary.title) ? summary.title : null,
            modified: summary.modified,
            messageCount: summary.messageCount,
            reply: summary.lastReply || summary.lastMessage,
          },
        ];
      }),
    [recent, byAvatar],
  );
  const fromCast = useMemo<Entry[]>(
    () =>
      [...library.characters]
        .sort((a, b) => b.modified - a.modified)
        .slice(0, STACK_SIZE + 1)
        .map((character: CharacterSummary) => ({
          key: `char:${character.avatar}`,
          avatar: character.avatar,
          name: character.name,
          chatId: null,
          title: null,
          modified: character.modified,
          messageCount: 0,
          reply: character.greeting ?? '',
        })),
    [library.characters],
  );

  const screen: Screen = refused
    ? 'refused'
    : recent === null || !settings
      ? 'loading'
      : fromChats.length
        ? 'home'
        : library.characters.length
          ? 'cast'
          : 'empty';
  const entries = screen === 'home' ? fromChats : screen === 'cast' ? fromCast : [];
  const lead = entries[0] ?? null;
  // The stack leads with the chat you were last in, so the mouse can always get back to it.
  const stack = entries.slice(0, STACK_SIZE + 1);

  // The stack lights the name under the mouse at once, but the cover and the colour follow
  // only once you rest on one: passing over names, or wavering between two, never starts a
  // swap for each name crossed.
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (picked === settled) return;
    const timer = setTimeout(() => setSettled(picked), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [picked, settled]);
  const shown = stack[settled] ?? lead;

  // A stale pick (the list changed under it) falls back to the last chat.
  useEffect(() => {
    if (picked >= stack.length) setPicked(0);
    if (settled >= stack.length) setSettled(0);
  }, [picked, settled, stack.length]);

  // --- Colour -------------------------------------------------------------------------------

  const avatarUrlOf = useCallback(
    (avatar: string) => characterApi.imageUrl(avatar, library.characterAvatarVersions[avatar]),
    [library.characterAvatarVersions],
  );
  // Every stacked character's colour, worked out once and kept: a name's colour must be
  // known before it is hovered, or the page would flash neutral on the way to it. Their
  // portraits are fetched up front for the same reason.
  const [palettes, setPalettes] = useState<
    Readonly<Record<string, { url: string; palette: PortraitPalette | null }>>
  >({});
  useEffect(() => {
    let live = true;
    for (const entry of stack) {
      const url = avatarUrlOf(entry.avatar);
      void preloadPortrait(url);
      void cachedAvatarPalette(url).then((palette) => {
        if (!live) return;
        setPalettes((current) =>
          current[entry.avatar]?.url === url && current[entry.avatar]?.palette === palette
            ? current
            : { ...current, [entry.avatar]: { url, palette } },
        );
      });
    }
    return () => {
      live = false;
    };
  }, [stack, avatarUrlOf]);
  const paletteOf = useCallback(
    (avatar: string) => {
      const url = avatarUrlOf(avatar);
      const known = palettes[avatar];
      return known?.url === url ? known.palette : peekAvatarPalette(url);
    },
    [palettes, avatarUrlOf],
  );
  const colorOf = useCallback(
    (avatar: string) => {
      const override = prefs.dialogueColors.characters[avatar];
      const known = paletteOf(avatar);
      if (needsPortrait(override) && known === undefined) return undefined;
      return resolveSpeakerColors(true, override, known ?? null).accent;
    },
    [paletteOf, prefs.dialogueColors.characters],
  );
  const auraOf = (avatar: string) => {
    const override = prefs.dialogueColors.characters[avatar];
    const known = paletteOf(avatar);
    if (needsPortrait(override) && known === undefined) return undefined;
    return resolveSpeakerColors(true, override, known ?? null).aura;
  };

  // Until a colour is known, the last one stays: never a flash of neutral in between.
  const lastColor = useRef<AuraInput>(null);
  const wanted =
    screen === 'empty' || onApps
      ? LIME
      : screen === 'refused'
        ? null
        : shown
          ? auraOf(shown.avatar)
          : undefined;
  if (wanted !== undefined) lastColor.current = wanted;
  const coverColor = wanted === undefined ? lastColor.current : wanted;

  const persona = library.personas.find((entry) => entry.id === settings?.personaId) ?? null;
  const personaAvatarUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, library.personaAvatarVersions[persona.id] ?? persona.avatar)
    : null;
  const personaOverride = persona ? prefs.dialogueColors.personas[persona.id] : undefined;
  const personaAuto = useAvatarPalette(needsPortrait(personaOverride) ? personaAvatarUrl : null);
  const personaColor = resolveSpeakerColors(true, personaOverride, personaAuto).aura;

  // Hovering re-tints without the wash a character switch sends: it is a preview, not a move.
  useAura(rootRef, washRef, coverColor, personaColor, 'home');
  const [firstAura] = useState(() => initialAuraStyle(coverColor, personaColor));

  // Deleting from the stack: the row goes at once, the chat goes to the trash bin.
  const deleteEntry = useCallback(
    (entry: Entry) => {
      const id = entry.chatId;
      if (!id) return;
      setRecent((list) => list?.filter((summary) => summary.id !== id) ?? list);
      setPicked(0);
      void controller.backups.deleteChat(id);
    },
    [controller.backups],
  );

  // --- Going places ---------------------------------------------------------------------------

  const openEntry = useCallback(
    (entry: Entry | null) => {
      if (!entry) return;
      if (entry.chatId) controller.openRecentChat(entry.avatar, entry.chatId);
      else controller.selectCharacter(entry.avatar);
    },
    [controller],
  );

  const openTool = useCallback(
    (id: ToolId) => {
      setOpened(null);
      setTool((current) => (current === id ? null : id));
    },
    [setTool],
  );
  // Search opens a tool onto something; it never closes the one already open.
  const showTool = useCallback(
    (id: ToolId) => {
      setOpened(null);
      setTool(id);
    },
    [setTool],
  );

  const collapse = useCallback(() => setOpened(null), []);
  const openPane = useCallback((next: IslandMode) => {
    setOpened((current) => (current === next ? null : next));
  }, []);

  // ↑/↓ walk the stack, Enter opens what the cover shows, Escape returns to the last chat,
  // ⌘K searches. Keys are left alone while something nearer has them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpened((current) => (current === 'search' ? null : 'search'));
        return;
      }
      if (event.defaultPrevented || opened) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .w3-margin')) return;
      if (event.key === 'Escape' && tool) {
        setTool(null);
        return;
      }
      if (screen !== 'home' && screen !== 'cast') return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setPicked((current) =>
          Math.max(0, stepStack(current, stack.length, event.key === 'ArrowDown' ? 1 : -1)),
        );
      } else if (event.key === 'Escape') {
        setPicked(0);
      } else if (event.key === 'Enter' && !target?.closest('button, a')) {
        event.preventDefault();
        openEntry(stack[picked] ?? shown);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opened, tool, screen, stack, picked, openEntry, shown, setTool]);

  // Scrolling to Create | Arena hands over at a third of the way: the cover lifts away, the
  // words slide in and the colour cools to lime, each on its own transition. State, not a
  // per-frame style write, so nothing can leave the panel half-drawn.
  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const progress = viewport.scrollTop / Math.max(1, viewport.clientHeight);
    setOnApps((current) => (current ? progress > 0.2 : progress > 0.35));
  }, []);

  // --- Importing: the empty screen's first button, or a card dropped anywhere ---------------

  const importFiles = useCallback(
    async (files: readonly File[]) => {
      const cards = files.filter((file) => /\.(png|json)$/i.test(file.name));
      if (!cards.length) return;
      const failures: string[] = [];
      for (const file of cards) {
        try {
          await characterApi.import(file);
        } catch (err) {
          failures.push(`${file.name}: ${(err as Error).message}`);
        }
      }
      await library.refresh();
      const imported = cards.length - failures.length;
      if (failures.length)
        say({
          icon: 'alert',
          title: imported ? `Imported ${imported}, ${failures.length} failed` : 'Import failed',
          text: failures.join(' · '),
          tone: 'bad',
          sticky: true,
        });
      else say({ icon: 'upload', title: 'Imported', text: plural(imported, 'character') });
    },
    [library, say],
  );
  const [dropping, setDropping] = useState(false);
  const onDragOver = (event: DragEvent) => {
    if (screen === 'refused' || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDropping(true);
  };
  const onDrop = (event: DragEvent) => {
    if (screen === 'refused') return;
    event.preventDefault();
    setDropping(false);
    void importFiles([...event.dataTransfer.files]);
  };

  // --- Island ---------------------------------------------------------------------------------

  const recentCharacters = useMemo(() => {
    const seen = new Set<string>();
    const list: CharacterSummary[] = [];
    for (const entry of fromChats) {
      const summary = byAvatar.get(entry.avatar);
      if (!summary || seen.has(entry.avatar)) continue;
      seen.add(entry.avatar);
      list.push(summary);
    }
    return list;
  }, [fromChats, byAvatar]);

  const searchItems = useMemo<SearchItem[]>(
    () =>
      buildSearchItems({
        controller,
        recentCharacters,
        chats: [],
        characterName: '',
        avatarUrlOf,
        tools: [...HOME_LEFT, ...HOME_RIGHT],
        openTool,
        showTool,
        onOpenChat: () => {},
      }),
    [controller, recentCharacters, avatarUrlOf, openTool, showTool],
  );

  const personaFace = persona ? { name: persona.name, url: personaAvatarUrl } : null;
  const side = tool ? TOOLS[tool].side : null;
  const backdropUrl = prefs.backdrop.url;
  const mode: IslandMode = opened ?? 'rest';

  return (
    <ModelsProvider
      connections={settings?.connections ?? []}
      recentModels={settings?.recentModels ?? []}
      chatModel={models.slots.chat}
      onRecentModels={app.rememberModels}
      favoriteModels={settings?.favoriteModels ?? []}
      onFavoriteModels={app.setFavoriteModels}
      pickerGroups={settings?.modelPickerGroups ?? {}}
      onPickerGroups={app.setModelPickerGroups}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping a card anywhere imports it; the buttons are the accessible way */}
      <div
        ref={rootRef}
        className="wc3 w3-home"
        data-overlay-root
        data-screen={screen}
        data-margin={side ?? undefined}
        data-wide={
          (tool === 'preset' && controller.presetPrompt) ||
          (tool === 'memory' && controller.memoryPrompt) ||
          (tool === 'lorebooks' && controller.lorePage?.entry != null)
            ? ''
            : undefined
        }
        data-image={Boolean(backdropUrl)}
        data-dropping={dropping || undefined}
        data-apps={onApps || undefined}
        onDragOver={onDragOver}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
        style={
          {
            ...firstAura,
            '--w3-bg-blur': `${prefs.backdrop.blur}px`,
            '--w3-bg-dim': prefs.backdrop.dim,
          } as CSSProperties
        }
      >
        <Backdrop url={backdropUrl} />
        <div className="w3-aura" aria-hidden="true" />
        {backdropUrl ? <div className="w3-scrim" aria-hidden="true" /> : null}

        <div className="w3-scene">
          <div
            className="w3-home__viewport"
            ref={viewportRef}
            onScroll={screen === 'refused' ? undefined : onScroll}
          >
            <section className="w3-home__panel" aria-label="Home">
              <ErrorBoundary where="the home screen" resetKeys={[screen]}>
                {screen === 'home' || screen === 'cast' ? (
                  shown ? (
                    <Cover
                      entry={shown}
                      isLead={shown === lead}
                      cast={screen === 'cast'}
                      castSize={library.characters.length}
                      imageUrl={avatarUrlOf(shown.avatar)}
                      personaName={persona?.name ?? 'you'}
                      onOpen={() => openEntry(shown)}
                    />
                  ) : null
                ) : screen === 'empty' ? (
                  <Welcome
                    onImport={() => importRef.current?.click()}
                    onCreate={() => void controller.enterCoCreator()}
                  />
                ) : screen === 'refused' ? (
                  <Refused message={refused ?? ''} onCopied={(ok) => say(copied(ok))} />
                ) : null}

                {screen === 'home' || screen === 'cast' ? (
                  <Stack
                    entries={stack}
                    picked={picked}
                    cast={screen === 'cast'}
                    colorOf={colorOf}
                    onPick={setPicked}
                    onOpen={openEntry}
                    onDelete={deleteEntry}
                  />
                ) : null}
              </ErrorBoundary>

              {screen !== 'refused' && version ? <Version info={version} /> : null}
              {screen !== 'refused' && screen !== 'loading' ? (
                <button
                  type="button"
                  className="w3-home__cue"
                  onClick={() =>
                    viewportRef.current?.scrollTo({
                      top: viewportRef.current.clientHeight,
                      behavior: 'smooth',
                    })
                  }
                >
                  Create · Arena <Icon name="chevronDown" size="xs" />
                </button>
              ) : null}
            </section>

            {screen !== 'refused' ? (
              <section className="w3-home__panel w3-home__apps" aria-label="Create and Arena">
                <div className="w3-home__half w3-home__half--l">
                  <span className="w3-home__mono">Make</span>
                  <button
                    type="button"
                    className="w3-home__app"
                    onClick={() => void controller.enterCoCreator()}
                  >
                    Create
                  </button>
                  <p className="w3-home__italic">Someone new, or a better preset.</p>
                  <span className="w3-home__pair">
                    <button type="button" onClick={() => void controller.enterCoCreator()}>
                      <Icon name="sparkles" size="sm" />
                      <b>Character Co-Creator</b>
                      <span>Build a card by talking it through.</span>
                    </button>
                    <button type="button" onClick={() => void controller.enterCoCreator('preset')}>
                      <Icon name="sliders" size="sm" />
                      <b>Preset Co-Creator</b>
                      <span>Tune a preset: ask, edit, test, send back.</span>
                    </button>
                  </span>
                  <span className="w3-home__links">
                    <button type="button" onClick={() => void controller.enterStudio()}>
                      Studio
                    </button>
                  </span>
                </div>
                <div className="w3-home__half w3-home__half--r">
                  <span className="w3-home__mono">Compare</span>
                  <button
                    type="button"
                    className="w3-home__app"
                    onClick={() => void controller.enterArena()}
                  >
                    Arena
                  </button>
                  <p className="w3-home__italic">Find the model that writes them best.</p>
                  <p className="w3-home__desc">
                    Put models head to head on your own characters, run a tournament, or see what
                    you spend.
                  </p>
                  <span className="w3-home__links">
                    <button type="button" onClick={() => void controller.enterArena()}>
                      Arena
                    </button>
                    <button type="button" onClick={() => void controller.enterStats()}>
                      Stats
                    </button>
                  </span>
                </div>
              </section>
            ) : null}
          </div>
        </div>

        <div className="w3-wash" ref={washRef} aria-hidden="true" />

        {tool ? (
          <aside className="w3-margin" data-side={side} key={tool} aria-label={TOOLS[tool].title}>
            <header className="w3-margin__head">
              <div className="w3-margin__title">
                <ToolHeading id={tool} controller={controller} />
                <span>{toolSubtitle(tool, controller)}</span>
              </div>
              <button
                type="button"
                className="w3-margin__close"
                aria-label={`Close ${TOOLS[tool].title}`}
                onClick={() => setTool(null)}
              >
                <Icon name="close" size="sm" />
              </button>
            </header>
            <div className="w3-margin__body">
              <ErrorBoundary
                where={TOOLS[tool].title}
                resetKeys={[
                  tool,
                  controller.characterSheet,
                  controller.personaPage,
                  controller.presetPrompt,
                  controller.lorePage?.book,
                ]}
              >
                <MarginTool id={tool} controller={controller} />
              </ErrorBoundary>
            </div>
          </aside>
        ) : null}

        <Island
          mode={screen === 'refused' ? 'rest' : mode}
          generating={false}
          onCollapse={collapse}
          notice={notice}
          onDismissNotice={() => {
            app.clearChatModelError();
            setNotice(null);
          }}
          wingsPinned={Boolean(tool)}
          wingLeft={
            screen === 'refused'
              ? null
              : HOME_LEFT.map((id) => (
                  <WingButton
                    key={id}
                    icon={TOOLS[id].icon}
                    label={TOOLS[id].title}
                    pressed={tool === id}
                    onClick={() => openTool(id)}
                  />
                ))
          }
          wingRight={
            screen === 'refused'
              ? null
              : HOME_RIGHT.map((id) => (
                  <WingButton
                    key={id}
                    icon={TOOLS[id].icon}
                    label={TOOLS[id].title}
                    pressed={tool === id}
                    onClick={() => openTool(id)}
                  />
                ))
          }
          panes={{
            rest:
              screen === 'refused' ? (
                <span className="w3-home__isl-note">
                  <i aria-hidden="true" />
                  No library open
                </span>
              ) : (
                <RestPane
                  character={null}
                  chatTitle=""
                  persona={personaFace}
                  onOpen={(next) =>
                    next === 'persona' && !persona && !library.personas.length
                      ? openTool('personas')
                      : openPane(next)
                  }
                />
              ),
            persona: (
              <PersonaPane
                personas={library.personas}
                activeId={persona?.id ?? null}
                recentIds={settings?.recentPersonaIds ?? []}
                avatarUrl={(p) =>
                  p.avatar
                    ? personaApi.avatarUrl(p.id, library.personaAvatarVersions[p.id] ?? p.avatar)
                    : null
                }
                onPick={(id) => {
                  setOpened(null);
                  controller.selectPersona(id);
                }}
                onManage={() => openTool('personas')}
              />
            ),
            search: (
              <SearchPane
                active={mode === 'search'}
                items={searchItems}
                onRun={(item) => {
                  setOpened(null);
                  item.run();
                }}
              />
            ),
          }}
        />

        <input
          ref={importRef}
          type="file"
          accept=".png,.json,image/png,application/json"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            void importFiles(files);
          }}
        />
      </div>
    </ModelsProvider>
  );
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function copied(ok: boolean): Omit<IslandNotice, 'id'> {
  return ok
    ? { icon: 'copy', title: 'Copied' }
    : { icon: 'alert', title: 'Copying is blocked here', tone: 'bad' };
}

// --- The cover ----------------------------------------------------------------------------

/**
 * Sizes the headline so its widest line spans a share of the page, capped so a short name
 * does not fill the screen. Runs on mount, on resize, and once the display face has loaded.
 */
function useFitHeadline(
  ref: React.RefObject<HTMLElement | null>,
  share: number,
  key: string,
  cap: number,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text is the trigger, read through the element
  useLayoutEffect(() => {
    const element = ref.current;
    const frame = element?.closest('.w3-home__panel') as HTMLElement | null;
    if (!element || !frame) return;
    const fit = () => {
      const lines = [...element.querySelectorAll<HTMLElement>('.w3-home__line')];
      element.style.fontSize = '200px';
      const widest = Math.max(1, ...lines.map((line) => line.getBoundingClientRect().width));
      const width = frame.clientWidth;
      const size = Math.min((200 * width * share) / widest, width * cap);
      element.style.fontSize = `${size}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [ref, share, key, cap]);
}

/** A character's name may break into two lines; the screens' own headlines never do. */
function Headline({ text, share, split = true }: { text: string; share: number; split?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const lines = split ? splitName(text) : [text];
  useFitHeadline(ref, share, text, lines.length > 1 ? 0.13 : 0.24);
  return (
    <span ref={ref} className="w3-home__name">
      {lines.map((line) => (
        <span key={line} className="w3-home__line">
          {line}
        </span>
      ))}
    </span>
  );
}

/**
 * Portraits fetched and decoded ahead of time, kept alive so the browser keeps them decoded:
 * a cover can then fade in the instant a name is settled on, instead of waiting for a large
 * PNG to decode first, which is what made the fade start late.
 */
const decoded = new Map<string, Promise<void>>();
const DECODED_LIMIT = 40;
const keepAlive: HTMLImageElement[] = [];

function preloadPortrait(url: string): Promise<void> {
  const known = decoded.get(url);
  if (known) return known;
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  const ready = image.decode().catch(() => {});
  decoded.set(url, ready);
  keepAlive.push(image);
  if (keepAlive.length > DECODED_LIMIT) {
    const dropped = keepAlive.shift();
    if (dropped) decoded.delete(dropped.src);
  }
  return ready;
}

/** One cover in the stack of covers that cross-fade into each other. */
interface Page {
  id: number;
  entry: Entry;
  isLead: boolean;
  imageUrl: string;
}

/** How long a new cover may wait for its portrait to decode before it fades in anyway. */
const DECODE_WAIT_MS = 250;

/**
 * The cover, swapped as one piece. A new cover (portrait and text together) fades in over
 * the old one once its portrait has decoded; the old portrait stays solid underneath while
 * the old text fades out, and the old cover is removed once the new one is fully in. The
 * page never dips to dark, and portrait and words always change together.
 */
function Cover({
  entry: asked,
  isLead,
  cast,
  castSize,
  imageUrl,
  personaName,
  onOpen,
}: {
  entry: Entry;
  isLead: boolean;
  cast: boolean;
  castSize: number;
  imageUrl: string;
  personaName: string;
  onOpen: () => void;
}) {
  const nextId = useRef(1);
  const [pages, setPages] = useState<Page[]>(() => [{ id: 0, entry: asked, isLead, imageUrl }]);

  // Which cover is on top, read inside the effect without making it a trigger.
  const topKey = useRef(asked.key);
  topKey.current = pages.at(-1)?.entry.key ?? '';

  useEffect(() => {
    let live = true;
    const add = () => {
      if (!live) return;
      setPages((current) => {
        const top = current.at(-1);
        if (top?.entry.key === asked.key) {
          // Same cover, fresher data (a new reply, a rename): update in place.
          return top.entry === asked && top.isLead === isLead
            ? current
            : [...current.slice(0, -1), { ...top, entry: asked, isLead, imageUrl }];
        }
        const id = nextId.current++;
        return [...current, { id, entry: asked, isLead, imageUrl }];
      });
    };
    if (topKey.current === asked.key) {
      add();
      return;
    }
    const timer = setTimeout(add, DECODE_WAIT_MS);
    void preloadPortrait(imageUrl).then(add);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asked, isLead, imageUrl]);

  const top = pages.length - 1;
  return (
    <div className="w3-home__cover">
      {/* Mask the stack once: overlapping per-image masks thicken the soft edges, then
          snap back when the old image is removed. */}
      <div className="w3-home__portrait" aria-hidden="true">
        {pages.map((page) => (
          <CoverPortrait key={page.id} page={page} arriving={page.id > 0} />
        ))}
      </div>
      {pages.map((page, index) => (
        <CoverPage
          key={page.id}
          page={page}
          // Keep an entrance running if another pick interrupts it; removing its
          // animation would jump that layer to full opacity.
          arriving={page.id > 0}
          leaving={index < top}
          cast={cast}
          castSize={castSize}
          personaName={personaName}
          onOpen={onOpen}
          onArrived={() =>
            setPages((current) => current.slice(current.findIndex((p) => p.id === page.id)))
          }
        />
      ))}
    </div>
  );
}

function CoverPortrait({ page, arriving }: { page: Page; arriving: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="w3-home__page" data-arriving={arriving || undefined}>
      {broken ? (
        <span className="w3-home__initial">{[...page.entry.name.trim()][0]?.toUpperCase()}</span>
      ) : (
        <img src={page.imageUrl} alt="" draggable={false} onError={() => setBroken(true)} />
      )}
    </div>
  );
}

function CoverPage({
  page,
  arriving,
  leaving,
  cast,
  castSize,
  personaName,
  onOpen,
  onArrived,
}: {
  page: Page;
  arriving: boolean;
  leaving: boolean;
  cast: boolean;
  castSize: number;
  personaName: string;
  onOpen: () => void;
  onArrived: () => void;
}) {
  const { entry } = page;
  const quote = quoteOf(entry.reply, { char: entry.name, user: personaName });
  const kicker = cast
    ? `Your cast · ${plural(castSize, 'character')}`
    : `${page.isLead ? 'Where you left off' : 'From your recents'} · ${agoInWords(entry.modified)}`;
  const coverLine = cast ? 'Not met yet.' : (entry.title ?? whenInWords(entry.modified));

  return (
    <div
      className="w3-home__page"
      data-arriving={arriving || undefined}
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && arriving && !leaving) onArrived();
      }}
    >
      <div className="w3-home__left">
        <span className="w3-home__kicker">{kicker}</span>
        {quote ? <p className="w3-home__quote">{quote}</p> : <span className="w3-home__spacer" />}
        <p className="w3-home__dek">{coverLine}</p>
        <button
          type="button"
          className="w3-home__headline"
          onClick={onOpen}
          tabIndex={leaving ? -1 : undefined}
          aria-label={`${cast ? 'Start a chat with' : 'Continue with'} ${entry.name}`}
        >
          <Headline text={entry.name} share={0.58} />
        </button>
        <div className="w3-home__actions">
          <button
            type="button"
            className="w3-home__go"
            onClick={onOpen}
            tabIndex={leaving ? -1 : undefined}
          >
            {cast ? 'Start a chat' : 'Continue'} <kbd className="w3-kbd">↵</kbd>
          </button>
          <span className="w3-home__mono">
            {cast ? 'Opens with their greeting' : plural(entry.messageCount, 'message')}
          </span>
        </div>
      </div>
    </div>
  );
}

// --- The stack ----------------------------------------------------------------------------

function Stack({
  entries,
  picked,
  cast,
  colorOf,
  onPick,
  onOpen,
  onDelete,
}: {
  entries: readonly Entry[];
  picked: number;
  cast: boolean;
  colorOf: (avatar: string) => string | null | undefined;
  onPick: (index: number) => void;
  onOpen: (entry: Entry) => void;
  /** Sends the entry's chat to the trash bin. Two clicks, in place. */
  onDelete: (entry: Entry) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const arm = useArm();

  // Names shrink so the whole stack fits its column; past the smallest size it scrolls.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      const count = Math.max(1, entries.length);
      const size = Math.max(
        20,
        Math.min(element.clientWidth * 0.14, element.clientHeight / count / 1.08),
      );
      element.style.setProperty('--home-fs', `${size}px`);
      element.toggleAttribute('data-fits', element.scrollHeight <= element.clientHeight + 2);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [entries.length]);

  // The walked-to name stays in view when the stack scrolls.
  useEffect(() => {
    ref.current?.children[picked]?.scrollIntoView({ block: 'nearest' });
  }, [picked]);

  if (!entries.length) return null;
  return (
    <div className="w3-home__stack" ref={ref}>
      {entries.map((entry, index) => {
        const color = colorOf(entry.avatar);
        return (
          <div key={entry.key} className="w3-home__row" data-picked={index === picked || undefined}>
            {entry.chatId ? (
              <button
                type="button"
                className="w3-home__del"
                data-armed={arm.armed === entry.key || undefined}
                aria-label={`Delete the chat with ${entry.name}`}
                title={
                  arm.armed === entry.key
                    ? 'Click again to delete. It goes to the trash bin.'
                    : 'Delete this chat'
                }
                onClick={() => arm.press(entry.key, () => onDelete(entry))}
                onBlur={() => arm.armed === entry.key && arm.disarm()}
              >
                {arm.armed === entry.key ? 'Delete?' : <Icon name="trash" size="sm" />}
              </button>
            ) : null}
            <button
              type="button"
              className="w3-home__entry"
              data-picked={index === picked || undefined}
              data-lead={index === 0 || undefined}
              style={color ? ({ '--home-c': color } as CSSProperties) : undefined}
              onMouseEnter={() => onPick(index)}
              onFocus={() => onPick(index)}
              onClick={() => onOpen(entry)}
            >
              <b>{entry.name}</b>
              <span>
                {index === 0 && !cast
                  ? `Where you left off · ${agoInWords(entry.modified)}`
                  : cast
                    ? 'Never chatted'
                    : agoInWords(entry.modified)}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// --- The edges ----------------------------------------------------------------------------

function Welcome({ onImport, onCreate }: { onImport: () => void; onCreate: () => void }) {
  return (
    <div className="w3-home__cover">
      <span className="w3-home__mark" aria-hidden="true">
        W
      </span>
      <div className="w3-home__left">
        <span className="w3-home__kicker">Welcome</span>
        <p className="w3-home__body">
          Bring your SillyTavern cards and presets along, or make someone new with the Co-Creator.
          Drop a card anywhere on this screen to import it.
        </p>
        <p className="w3-home__dek">Nobody here yet.</p>
        <span className="w3-home__headline w3-home__headline--static">
          <Headline text="WackChatter" share={0.62} split={false} />
        </span>
        <div className="w3-home__actions">
          <button type="button" className="w3-home__go" onClick={onImport}>
            Import characters
          </button>
          <button type="button" className="w3-home__ghost" onClick={onCreate}>
            Create someone
          </button>
        </div>
      </div>
    </div>
  );
}

function Refused({ message, onCopied }: { message: string; onCopied: (ok: boolean) => void }) {
  return (
    <div className="w3-home__cover">
      <div className="w3-home__left">
        <span className="w3-home__kicker w3-home__kicker--bad">Library</span>
        <p className="w3-home__body">{message}</p>
        <p className="w3-home__dek">This library didn't open.</p>
        <span className="w3-home__headline w3-home__headline--static">
          <Headline text="Can't open it" share={0.72} split={false} />
        </span>
        <div className="w3-home__actions">
          <button type="button" className="w3-home__go" onClick={() => window.location.reload()}>
            Try again
          </button>
          <button
            type="button"
            className="w3-home__ghost"
            onClick={() =>
              void navigator.clipboard.writeText(message).then(
                () => onCopied(true),
                () => onCopied(false),
              )
            }
          >
            Copy details
          </button>
        </div>
      </div>
    </div>
  );
}

function Version({ info }: { info: VersionInfo }) {
  const behind = info.commitsBehind ?? 0;
  const where = info.branch && info.revision ? ` · ${info.branch} ${info.revision}` : '';
  return (
    <div className="w3-home__version" data-update={behind > 0 || undefined}>
      {behind > 0 ? (
        <>
          <i aria-hidden="true" />
          <b className="w3-home__update">Update ready</b>
          <span>
            · {plural(behind, 'commit')} behind · run <code>./update.sh</code>
          </span>
        </>
      ) : (
        <span>
          WackChatter {info.version}
          {where}
        </span>
      )}
    </div>
  );
}
