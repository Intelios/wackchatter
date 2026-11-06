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
import type { UiChoice } from '../app/uiChoice.ts';
import type { AppController } from '../app/useAppController.ts';
import { Backdrop } from '../components/Backdrop.tsx';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import {
  cachedAvatarColor,
  resolveDialogueColor,
  useAvatarColor,
} from '../features/chat/avatarColor.ts';
import { ModelsProvider } from '../features/models/ModelsContext.tsx';
import { characterApi, chatApi, personaApi, type VersionInfo, versionApi } from '../lib/api.ts';
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
import { MarginTool, TOOLS, type ToolId, toolSubtitle } from './MarginTools.tsx';
import { buildSearchItems } from './search.ts';
import { initialAuraStyle, useAura } from './useAura.ts';

/** The wings at home: everything that does not need a chat open. */
const HOME_LEFT: ToolId[] = ['characters', 'lorebooks', 'personas'];
const HOME_RIGHT: ToolId[] = ['prompts', 'generation', 'settings'];

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

export function HomeShell({
  controller,
  onUiChoice,
}: {
  controller: AppController;
  onUiChoice: (choice: UiChoice) => void;
}) {
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
  const [tool, setTool] = useState<ToolId | null>(null);
  const [opened, setOpened] = useState<IslandMode | null>(null);
  const [notice, setNotice] = useState<IslandNotice | null>(null);
  const [onApps, setOnApps] = useState(false);
  const noticeId = useRef(0);
  const say = useCallback((next: Omit<IslandNotice, 'id'>) => {
    noticeId.current += 1;
    setNotice({ ...next, id: noticeId.current });
  }, []);

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
  const [colors, setColors] = useState<Readonly<Record<string, string | null>>>({});
  useEffect(() => {
    let live = true;
    for (const entry of stack) {
      const url = avatarUrlOf(entry.avatar);
      new Image().src = url;
      void cachedAvatarColor(url).then((color) => {
        if (!live) return;
        setColors((current) =>
          current[entry.avatar] === color ? current : { ...current, [entry.avatar]: color },
        );
      });
    }
    return () => {
      live = false;
    };
  }, [stack, avatarUrlOf]);
  const colorOf = useCallback(
    (avatar: string) => {
      const override = prefs.dialogueColors.characters[avatar];
      return override === undefined ? colors[avatar] : override;
    },
    [colors, prefs.dialogueColors.characters],
  );

  // Until a colour is known, the last one stays: never a flash of neutral in between.
  const lastColor = useRef<string | null>(null);
  const wanted =
    screen === 'empty' || onApps
      ? LIME
      : screen === 'refused'
        ? null
        : shown
          ? colorOf(shown.avatar)
          : undefined;
  if (wanted !== undefined) lastColor.current = wanted;
  const coverColor = wanted === undefined ? lastColor.current : wanted;

  const persona = library.personas.find((entry) => entry.id === settings?.personaId) ?? null;
  const personaAvatarUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, library.personaAvatarVersions[persona.id] ?? persona.avatar)
    : null;
  const personaOverride = persona ? prefs.dialogueColors.personas[persona.id] : undefined;
  const personaAuto = useAvatarColor(personaOverride == null ? personaAvatarUrl : null);
  const personaColor = resolveDialogueColor(true, personaOverride, personaAuto).color;

  // Hovering re-tints without the wash a character switch sends: it is a preview, not a move.
  useAura(rootRef, washRef, coverColor, personaColor, 'home');
  const [firstAura] = useState(() => initialAuraStyle(coverColor, personaColor));

  // --- Going places ---------------------------------------------------------------------------

  const openEntry = useCallback(
    (entry: Entry | null) => {
      if (!entry) return;
      if (entry.chatId) controller.openRecentChat(entry.avatar, entry.chatId);
      else controller.selectCharacter(entry.avatar);
    },
    [controller],
  );

  const openTool = useCallback((id: ToolId) => {
    setOpened(null);
    setTool((current) => (current === id ? null : id));
  }, []);

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
  }, [opened, tool, screen, stack, picked, openEntry, shown]);

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
        onOpenChat: () => {},
      }),
    [controller, recentCharacters, avatarUrlOf, openTool],
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
        <div className="w3-aura" aria-hidden="true">
          <span className="w3-orb w3-orb--1" />
          <span className="w3-orb w3-orb--2" />
          <span className="w3-orb w3-orb--3" />
        </div>
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
                  <p className="w3-home__desc">
                    Shape a character or tune a preset with the Co-Creator, or build a card by hand
                    in the Studio.
                  </p>
                  <span className="w3-home__links">
                    <button type="button" onClick={() => void controller.enterCoCreator()}>
                      Co-Creator
                    </button>
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
                <h2>{TOOLS[tool].title}</h2>
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
              <ErrorBoundary where={TOOLS[tool].title} resetKeys={[tool, controller.editing]}>
                <MarginTool id={tool} controller={controller} onUiChoice={onUiChoice} />
              </ErrorBoundary>
            </div>
          </aside>
        ) : null}

        <Island
          mode={screen === 'refused' ? 'rest' : mode}
          generating={false}
          onCollapse={collapse}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
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

/** How long the old cover takes to leave before the new one is set in. */
const SWAP_OUT_MS = 150;

/**
 * Holds what the cover shows a beat behind what was asked for: the old cover fades out, the
 * new one is set while invisible, then fades in. Moving quickly across the stack only ever
 * lands on the last name; the ones skipped past are never drawn.
 */
function useSwap<T extends { key: string }>(next: T): { shown: T; out: boolean } {
  const [shown, setShown] = useState(next);
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (next.key === shown.key) {
      setShown(next);
      setOut(false);
      return;
    }
    setOut(true);
    const timer = setTimeout(() => {
      setShown(next);
      setOut(false);
    }, SWAP_OUT_MS);
    return () => clearTimeout(timer);
  }, [next, shown.key]);
  return { shown, out };
}

function Cover({
  entry: asked,
  isLead,
  cast,
  castSize,
  imageUrl: askedUrl,
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
  const target = useMemo(
    () => ({ key: asked.key, entry: asked, isLead, imageUrl: askedUrl }),
    [asked, isLead, askedUrl],
  );
  const { shown, out } = useSwap(target);
  const { entry } = shown;
  const quote = quoteOf(entry.reply, { char: entry.name, user: personaName });
  const kicker = cast
    ? `Your cast · ${plural(castSize, 'character')}`
    : `${shown.isLead ? 'Where you left off' : 'From your recents'} · ${agoInWords(entry.modified)}`;
  const coverLine = cast ? 'Not met yet.' : (entry.title ?? whenInWords(entry.modified));

  return (
    <div className="w3-home__cover" data-out={out || undefined}>
      <Portraits url={askedUrl} name={asked.name} />
      <div className="w3-home__left">
        <span className="w3-home__kicker w3-home__swap">{kicker}</span>
        {quote ? (
          <p className="w3-home__quote w3-home__swap">{quote}</p>
        ) : (
          <span className="w3-home__spacer" />
        )}
        <p className="w3-home__dek w3-home__swap">{coverLine}</p>
        <button
          type="button"
          className="w3-home__headline w3-home__swap"
          onClick={onOpen}
          aria-label={`${cast ? 'Start a chat with' : 'Continue with'} ${asked.name}`}
        >
          <Headline text={entry.name} share={0.58} />
        </button>
        <div className="w3-home__actions">
          <button type="button" className="w3-home__go" onClick={onOpen}>
            {cast ? 'Start a chat' : 'Continue'} <kbd className="w3-kbd">↵</kbd>
          </button>
          <span className="w3-home__mono w3-home__swap">
            {cast ? 'Opens with their greeting' : plural(entry.messageCount, 'message')}
          </span>
        </div>
      </div>
    </div>
  );
}

/** One portrait in the cross-fade, or the initial when its image will not load. */
interface PortraitLayer {
  url: string;
  name: string;
  broken: boolean;
}

/**
 * The cover's portrait, cross-faded: a new portrait is decoded first, then fades in over the
 * old one, which is only dropped once it is covered. The page never shows the hole between
 * two portraits, which is what read as a flicker.
 */
function Portraits({ url, name }: { url: string; name: string }) {
  const [layers, setLayers] = useState<PortraitLayer[]>([{ url, name, broken: false }]);
  useEffect(() => {
    let live = true;
    const image = new Image();
    image.src = url;
    const add = (broken: boolean) => {
      if (!live) return;
      setLayers((current) =>
        current.at(-1)?.url === url
          ? current
          : // At most the one being covered and the one arriving.
            [...current.slice(-1), { url, name, broken }],
      );
    };
    image.decode().then(
      () => add(false),
      () => add(true),
    );
    return () => {
      live = false;
    };
  }, [url, name]);

  return (
    <div className="w3-home__portrait" aria-hidden="true">
      {layers.map((layer, index) => (
        <div
          key={layer.url}
          className="w3-home__layer"
          data-arriving={index === layers.length - 1 && layers.length > 1 ? '' : undefined}
          onAnimationEnd={() => setLayers((current) => current.slice(-1))}
        >
          {layer.broken ? (
            <span className="w3-home__initial">{[...layer.name.trim()][0]?.toUpperCase()}</span>
          ) : (
            <img src={layer.url} alt="" draggable={false} />
          )}
        </div>
      ))}
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
}: {
  entries: readonly Entry[];
  picked: number;
  cast: boolean;
  colorOf: (avatar: string) => string | null | undefined;
  onPick: (index: number) => void;
  onOpen: (entry: Entry) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

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
          <button
            key={entry.key}
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
