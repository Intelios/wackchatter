/**
 * The 3.0 shell.
 *
 * Markup over the app controller, like `LegacyShell`, so it inherits every behaviour
 * unchanged. It covers the chat for now: the island and its wings, the margin, the
 * transcript and the Line, the home screen, the Studio, both Co-Creators, the Arena and
 * Stats (the hand-off to TokenTrail).
 */

import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/instrument-sans/index.css';
import './shell.css';
import './island.css';
import './stage.css';
import './bridge.css';

import { greetingTexts } from '@shared/chat/message.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary } from '@shared/types/chat.ts';
import type { ActivationResult } from '@shared/worldinfo/activate.ts';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LegacyShell } from '../app/LegacyShell.tsx';
import type { UiChoice } from '../app/uiChoice.ts';
import type { AppController } from '../app/useAppController.ts';
import { Backdrop } from '../components/Backdrop.tsx';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { resolveDialogueColor, useAvatarColor } from '../features/chat/avatarColor.ts';
import { CardReader } from '../features/chat/CardReader.tsx';
import { useChatSurface } from '../features/chat/useChatSurface.ts';
import { ModelsProvider } from '../features/models/ModelsContext.tsx';
import { NexusExplorer } from '../features/nexus/NexusExplorer.tsx';
import { characterApi, chatApi, personaApi } from '../lib/api.ts';
import { downloadUrl } from '../lib/download.ts';
import { Arena } from './Arena.tsx';
import { ChatStage } from './ChatStage.tsx';
import { CoCreator } from './CoCreator.tsx';
import { HomeShell } from './Home.tsx';
import { Island, type IslandMode, type IslandNotice, WingButton } from './Island.tsx';
import {
  type CastAction,
  CastPane,
  GenPane,
  PersonaPane,
  RecapPane,
  RestPane,
  type SearchItem,
  SearchPane,
} from './IslandPanes.tsx';
import { Icon } from './icons.tsx';
import { introLine } from './intro.ts';
import type { LineHandle } from './LineComposer.tsx';
import { busiestBook, loreMoment } from './lore.ts';
import {
  LEFT_TOOLS,
  MarginTool,
  RIGHT_TOOLS,
  TOOLS,
  ToolHeading,
  type ToolId,
  toolSubtitle,
} from './MarginTools.tsx';
import { PresetCoCreator } from './PresetCoCreator.tsx';
import { Stats } from './Stats.tsx';
import { Studio } from './Studio.tsx';
import { buildSearchItems } from './search.ts';
import { initialAuraStyle, replay, useAura } from './useAura.ts';

export function Shell({
  controller,
  onUiChoice,
}: {
  controller: AppController;
  onUiChoice: (choice: UiChoice) => void;
}) {
  /*
   * Picking a character clears the old card before the new one arrives. Through that gap
   * the screen you were on stays: the last chat (its own character and card together, never
   * mixed with the next one's), or home when there was no chat. Nothing flashes between.
   */
  const shown = useRef<{ active: CharacterSummary; character: CardData } | null>(null);
  const { view, active, character } = controller;
  if (view === 'app' && active && character) shown.current = { active, character };
  if (view === 'app' && !active) shown.current = null;

  if (view === 'app' && active && character) {
    return (
      <ChatShell
        controller={controller}
        active={active}
        character={character}
        onUiChoice={onUiChoice}
      />
    );
  }
  if (view === 'app' && shown.current) {
    return <ChatShell controller={controller} {...shown.current} onUiChoice={onUiChoice} />;
  }
  if (view === 'app') return <HomeShell controller={controller} onUiChoice={onUiChoice} />;
  if (view === 'studio') return <Studio controller={controller} />;
  if (view === 'cocreator' && controller.coCreatorMode === 'preset') {
    return <PresetCoCreator controller={controller} />;
  }
  if (view === 'cocreator') return <CoCreator controller={controller} />;
  if (view === 'arena') return <Arena controller={controller} />;
  if (view === 'tokentrail') return <Stats controller={controller} />;
  // Nothing else should reach here; the 2.x shell stays as the floor until it is deleted.
  return <LegacyShell controller={controller} />;
}

/** The open character's card, as the controller holds it. */
type CardData = NonNullable<AppController['character']>;

const BUSY = 'Wait for the current reply to finish.';

function ChatShell({
  controller,
  active,
  character,
  onUiChoice,
}: {
  controller: AppController;
  active: CharacterSummary;
  character: CardData;
  onUiChoice: (choice: UiChoice) => void;
}) {
  const { app, library, backups, chat } = controller;
  const { settings, view: prefs, models } = app;
  const { state } = chat;

  const rootRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const bloomRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<LineHandle>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const [tool, setTool] = useState<ToolId | null>(null);
  const { setCharacterSheet, setPersonaPage, setPresetPrompt, setLorePage } = controller;
  // A character's sheet and a persona's page belong to their tools: leaving the tool goes
  // back to its list.
  useEffect(() => {
    if (tool !== 'characters') setCharacterSheet(null);
    if (tool !== 'personas') setPersonaPage(null);
    if (tool !== 'preset') setPresetPrompt(null);
    if (tool !== 'lorebooks') setLorePage(null);
  }, [tool, setCharacterSheet, setPersonaPage, setPresetPrompt, setLorePage]);
  const [opened, setOpened] = useState<IslandMode | null>(null);
  const [notice, setNotice] = useState<IslandNotice | null>(null);
  const noticeId = useRef(0);
  const say = useCallback((next: Omit<IslandNotice, 'id'>) => {
    noticeId.current += 1;
    setNotice({ ...next, id: noticeId.current });
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const characterName = character.name || active.name;
  const characterAvatarVersion = library.characterAvatarVersions[active.avatar];

  const surface = useChatSurface({
    chat,
    avatar: active.avatar,
    characterAvatarVersion,
    personas: library.personas,
    onSelectPersona: controller.selectPersona,
    onOpenPanel: (panel) => {
      if (panel === 'persona') setTool('personas');
      else if (panel === 'characters') setTool('characters');
      else if (panel === 'lorebooks') setTool('lorebooks');
      else if (panel === 'summary') setTool('memory');
      else setTool('settings');
    },
    creatorNotes: character.creator_notes ?? '',
    card: character,
    onEditCharacter: () => {
      setCharacterSheet(active.avatar);
      setTool('characters');
    },
    dialogueColors: prefs.dialogueColors,
    regexScripts: prefs.regexScripts,
    onImpersonated: (text) => lineRef.current?.replace(text),
  });

  // --- Aura: the character's colour themes everything; yours themes what is yours -------

  // The theme follows the character's colour even when dialogue colouring is switched off:
  // that setting is about quoted speech, not the app.
  const characterOverride = prefs.dialogueColors.characters[active.avatar];
  const characterAuto = useAvatarColor(
    characterOverride == null ? surface.characterAvatarUrl : null,
  );
  const auraColor = characterOverride ?? characterAuto ?? null;

  const persona = chat.persona;
  const personaAvatarUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, library.personaAvatarVersions[persona.id] ?? persona.avatar)
    : null;
  const personaOverride = persona ? prefs.dialogueColors.personas[persona.id] : undefined;
  const personaAuto = useAvatarColor(personaOverride == null ? personaAvatarUrl : null);
  const personaColor = resolveDialogueColor(true, personaOverride, personaAuto).color;

  useAura(rootRef, washRef, auraColor, personaColor, active.avatar);
  const [firstAura] = useState(() => initialAuraStyle(auraColor, personaColor));

  // --- Generating ----------------------------------------------------------------------

  const generating = state.status !== 'idle';
  const summarising = chat.summaryStatus.running;
  const impersonating = surface.impersonating;
  const recapping = generating && surface.recapRunning;
  const islandBase: IslandMode = generating || summarising ? 'gen' : 'rest';
  const mode: IslandMode = surface.recapOpen ? 'recap' : (opened ?? islandBase);

  const collapse = useCallback(() => {
    setOpened(null);
    if (surface.recapOpen) surface.closeRecap();
  }, [surface.recapOpen, surface.closeRecap]);

  const open = useCallback((next: IslandMode) => {
    setOpened((current) => (current === next ? null : next));
  }, []);

  // ⌘K / Ctrl+K opens search from anywhere in the chat.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpened((current) => (current === 'search' ? null : 'search'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Escape closes the margin when nothing nearer has claimed it.
  useEffect(() => {
    if (!tool) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !opened) setTool(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, opened]);

  // A summary or memory run reports through the island.
  const wasSummarising = useRef(false);
  useEffect(() => {
    if (wasSummarising.current && !summarising) {
      const status = chat.summaryStatus;
      if (status.error)
        say({
          icon: 'alert',
          title: 'Summary stopped',
          text: status.error,
          tone: 'bad',
          sticky: true,
        });
      else if (status.processed)
        say({
          icon: 'memory',
          title: status.mode === 'rewrite' ? 'Memory rewritten' : `Memory +${status.processed}`,
          text:
            status.mode === 'rewrite'
              ? `from ${status.processed} messages`
              : `${status.processed === 1 ? 'message' : 'messages'} folded in`,
          action: {
            label: 'Open',
            run: () => {
              setOpened(null);
              setTool('memory');
            },
          },
        });
    }
    wasSummarising.current = summarising;
  }, [summarising, chat.summaryStatus, say]);

  // A failed reply also flags itself on the island, briefly; the full notice is inline.
  const lastError = useRef<string | null>(null);
  useEffect(() => {
    if (state.error && state.error !== lastError.current) {
      say({
        icon: 'alert',
        title: 'Reply failed',
        text: 'see the chat for what happened',
        tone: 'bad',
      });
    }
    lastError.current = state.error;
  }, [state.error, say]);

  // --- Faces -----------------------------------------------------------------------------

  const characterFace = { name: characterName, url: surface.characterAvatarUrl };
  const personaFace = persona ? { name: persona.name, url: personaAvatarUrl } : null;
  const avatarUrlOf = useCallback(
    (avatar: string) => characterApi.imageUrl(avatar, library.characterAvatarVersions[avatar]),
    [library.characterAvatarVersions],
  );

  // --- Recent characters, for the character pane ----------------------------------------

  const [recentChats, setRecentChats] = useState<ChatSummary[]>([]);
  useEffect(() => {
    if (opened !== 'cast' && opened !== 'search') return;
    let live = true;
    chatApi
      .recent(40)
      .then((list) => {
        if (live) setRecentChats(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [opened]);

  const byAvatar = useMemo(
    () => new Map(library.characters.map((summary) => [summary.avatar, summary])),
    [library.characters],
  );
  const recentCharacters = useMemo(() => {
    const seen = new Set<string>([active.avatar]);
    const list: CharacterSummary[] = [];
    const current = byAvatar.get(active.avatar);
    if (current) list.push(current);
    for (const recent of recentChats) {
      if (list.length >= 6) break;
      if (seen.has(recent.characterId)) continue;
      const summary = byAvatar.get(recent.characterId);
      if (!summary) continue;
      seen.add(recent.characterId);
      list.push(summary);
    }
    return list;
  }, [recentChats, byAvatar, active.avatar]);

  // One line about the character, with its macros resolved like the greeting's.
  const description = byAvatar.get(active.avatar)?.description ?? '';
  const intro = useMemo(
    () => introLine(chat.renderGreeting(description)),
    [description, chat.renderGreeting],
  );

  // --- Chat actions (the old chat menu) --------------------------------------------------

  const busy = chat.busy;
  const hasChat = Boolean(state.chatId);
  const castActions: CastAction[] = hasChat
    ? [
        {
          id: 'new',
          label: 'New chat',
          icon: 'plus',
          run: () => void chat.newChat(),
          disabledReason: busy ? BUSY : undefined,
        },
        {
          id: 'checkpoint',
          label: 'Save checkpoint',
          icon: 'branch',
          run: () => {
            if (surface.lastId) void chat.branchFrom(surface.lastId);
            setOpened(null);
          },
          disabledReason: busy
            ? BUSY
            : !surface.lastId
              ? 'This chat has no messages yet.'
              : undefined,
        },
        {
          id: 'recap',
          label: 'Previously on…',
          icon: 'rewind',
          run: () => {
            setOpened(null);
            surface.runRecap();
          },
          disabledReason: chat.generationBlocked
            ? 'Wait for the current operation to finish.'
            : state.messages.length
              ? undefined
              : 'This chat has no messages yet.',
        },
        {
          id: 'export',
          label: 'Export',
          icon: 'download',
          run: () => state.chatId && downloadUrl(chatApi.exportUrl(state.chatId)),
          disabledReason: busy ? BUSY : undefined,
        },
        {
          id: 'import',
          label: 'Import',
          icon: 'upload',
          run: () => importRef.current?.click(),
          disabledReason: busy ? BUSY : undefined,
        },
        {
          id: 'close',
          label: 'Close chat',
          icon: 'close',
          run: () => {
            setOpened(null);
            void controller.closeChat();
          },
          disabledReason: busy ? BUSY : undefined,
        },
      ]
    : [
        {
          id: 'new',
          label: 'New chat',
          icon: 'plus',
          run: () => void chat.newChat(),
          disabledReason: busy ? BUSY : undefined,
        },
        {
          id: 'import',
          label: 'Import',
          icon: 'upload',
          run: () => importRef.current?.click(),
          disabledReason: busy ? BUSY : undefined,
        },
      ];

  // --- Search (⌘K) -----------------------------------------------------------------------

  const openTool = useCallback((id: ToolId) => {
    setOpened(null);
    setTool((current) => (current === id ? null : id));
  }, []);
  // Search opens a tool onto something; it never closes the one already open.
  const showTool = useCallback((id: ToolId) => {
    setOpened(null);
    setTool(id);
  }, []);

  const searchItems = useMemo<SearchItem[]>(
    () =>
      buildSearchItems({
        controller,
        recentCharacters,
        chats: chat.chats,
        characterName,
        avatarUrlOf,
        tools: [...LEFT_TOOLS, ...RIGHT_TOOLS],
        openTool,
        showTool,
        onOpenChat: (id) => void chat.openChat(id),
      }),
    [
      recentCharacters,
      chat.chats,
      chat.openChat,
      characterName,
      avatarUrlOf,
      controller,
      openTool,
      showTool,
    ],
  );

  // --- Margin ----------------------------------------------------------------------------

  const side = tool ? TOOLS[tool].side : null;
  const chooseModel = useCallback(() => openTool('preset'), [openTool]);

  /*
   * The lore this reply fired, for the island. Only a result that arrived after the reply
   * began counts: until the request is built, the last reply's lore is still the newest.
   */
  // Updated only while idle, so it still holds the previous reply's lore on the render where
  // a new reply starts, even when the new lore lands in that same render.
  const loreAtStart = useRef<ActivationResult | null>(null);
  if (!generating) loreAtStart.current = chat.worldInfo;
  const replyLore = useMemo(() => {
    if (!generating || summarising || !chat.worldInfo) return null;
    if (chat.worldInfo === loreAtStart.current) return null;
    const moment = loreMoment(chat.worldInfo);
    return moment ? { key: chat.worldInfo, ...moment } : null;
  }, [generating, summarising, chat.worldInfo]);
  const openReplyLore = useCallback(() => {
    const book = busiestBook(chat.worldInfo);
    if (!book) return;
    setOpened(null);
    setLorePage({ book, entry: null, filter: 'fired' });
    setTool('lorebooks');
  }, [chat.worldInfo, setLorePage]);

  const bloom = useCallback(() => replay(bloomRef.current), []);
  const onCopied = useCallback(
    (ok: boolean) =>
      say(
        ok
          ? { icon: 'copy', title: 'Copied' }
          : { icon: 'alert', title: 'Copying is blocked here', tone: 'bad' },
      ),
    [say],
  );

  const backdropUrl = prefs.backdrop.url;

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
      <div
        ref={rootRef}
        className="wc3"
        data-overlay-root
        data-margin={side ?? undefined}
        data-wide={
          tool === 'inspect' ||
          (tool === 'preset' && controller.presetPrompt) ||
          (tool === 'memory' && controller.memoryPrompt) ||
          (tool === 'lorebooks' && controller.lorePage?.entry != null)
            ? ''
            : undefined
        }
        data-image={Boolean(backdropUrl)}
        data-generating={generating || undefined}
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
        <div className="w3-breath" aria-hidden="true" />
        <div className="w3-bloom" ref={bloomRef} aria-hidden="true" />
        {backdropUrl ? <div className="w3-scrim" aria-hidden="true" /> : null}

        <div className="w3-scene">
          <ErrorBoundary where="the chat" resetKeys={[controller.selected, state.chatId]}>
            <ChatStage
              chat={chat}
              surface={surface}
              lineRef={lineRef}
              characterName={characterName}
              characterDescription={intro}
              greetingCount={greetingTexts(character).length}
              personaAvatarVersions={library.personaAvatarVersions}
              dialogueColors={prefs.dialogueColors}
              guidance={prefs.guidance}
              onGuidanceChange={(patch) =>
                void app.patchSettings({ guidance: { ...prefs.guidance, ...patch } })
              }
              ready={controller.ready}
              notReadyReason={models.chat.blockedReason}
              onChooseModel={chooseModel}
              onCopied={onCopied}
              onSent={bloom}
            />
          </ErrorBoundary>
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
                  controller.selected,
                ]}
              >
                <MarginTool
                  id={tool}
                  controller={controller}
                  onUiChoice={onUiChoice}
                  onOpenTool={setTool}
                />
              </ErrorBoundary>
            </div>
          </aside>
        ) : null}

        <Island
          mode={mode}
          generating={generating || summarising}
          onCollapse={collapse}
          notice={notice}
          onDismissNotice={dismissNotice}
          wingsPinned={Boolean(tool)}
          wingLeft={
            <>
              {/* Home first, where the way out of a place is expected to be. */}
              <WingButton
                icon="home"
                label="Home"
                pressed={false}
                disabledReason={busy ? BUSY : undefined}
                onClick={() => void controller.closeChat()}
              />
              {LEFT_TOOLS.map((id) => (
                <WingButton
                  key={id}
                  icon={TOOLS[id].icon}
                  label={TOOLS[id].title}
                  pressed={tool === id}
                  onClick={() => openTool(id)}
                />
              ))}
            </>
          }
          wingRight={RIGHT_TOOLS.map((id) => (
            <WingButton
              key={id}
              icon={TOOLS[id].icon}
              label={TOOLS[id].title}
              pressed={tool === id}
              onClick={() => openTool(id)}
            />
          ))}
          panes={{
            rest: (
              <RestPane
                character={characterFace}
                chatTitle={hasChat ? state.title : 'No chat open'}
                persona={personaFace}
                onOpen={open}
              />
            ),
            gen: (
              <GenPane
                who={impersonating && personaFace ? personaFace : characterFace}
                isPersona={impersonating}
                label={
                  summarising
                    ? 'Remembering'
                    : recapping
                      ? 'Writing the recap'
                      : impersonating
                        ? `Writing as ${persona?.name ?? 'you'}`
                        : `${characterName} is writing`
                }
                thinkingLabel={impersonating ? undefined : `${characterName} is thinking`}
                stream={chat.stream}
                live={generating && !summarising}
                detail={
                  summarising
                    ? `${chat.summaryStatus.processed} of ${chat.summaryStatus.total} messages`
                    : undefined
                }
                onStop={summarising ? chat.cancelSummary : chat.abort}
                lore={replyLore}
                onOpenLore={openReplyLore}
              />
            ),
            cast: (
              <CastPane
                active={mode === 'cast'}
                character={byAvatar.get(active.avatar) ?? active}
                description={intro}
                recent={recentCharacters}
                avatarUrl={avatarUrlOf}
                onPickCharacter={(avatar) => {
                  setOpened(null);
                  if (avatar !== active.avatar) controller.selectCharacter(avatar);
                }}
                onAllCharacters={() => openTool('characters')}
                onReadCard={() => {
                  setOpened(null);
                  surface.openCardReader();
                }}
                onEditCharacter={() => {
                  setOpened(null);
                  setCharacterSheet(active.avatar);
                  setTool('characters');
                }}
                chatTitle={state.title}
                messageCount={state.messages.length}
                hasChat={hasChat}
                onRename={(title) => chat.renameChat(title)}
                renameDisabledReason={busy ? BUSY : undefined}
                actions={castActions}
                chats={chat.chats}
                currentChatId={state.chatId}
                onOpenChat={(id) => {
                  setOpened(null);
                  void chat.openChat(id);
                }}
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
            recap: (
              <RecapPane
                title={state.title}
                status={surface.recapView.status}
                text={surface.recapView.text}
                error={surface.recapView.error}
                stream={chat.stream}
                modelName={models.chat.model?.model ?? null}
                dropped={surface.recapMeta?.dropped ?? 0}
                onStop={chat.abort}
                onClose={collapse}
              />
            ),
          }}
        />

        {surface.cardReader ? (
          <CardReader
            store={surface.cardStore}
            init={surface.cardReader}
            onClose={surface.closeCardReader}
            onEditCharacter={surface.editCharacter}
            busy={busy}
          />
        ) : null}

        <ErrorBoundary where="Memory Nexus" resetKeys={[state.chatId, chat.nexus.open]}>
          <NexusExplorer
            chat={chat}
            container={rootRef.current}
            settings={prefs.nexus}
            onSettingsChange={(patch) =>
              void app.patchSettings({ nexus: { ...prefs.nexus, ...patch } })
            }
            model={models.slots.nexus}
            onModelChange={(ref) => app.setModelSlot('nexus', ref)}
            blockedReason={models.nexus.blockedReason}
          />
        </ErrorBoundary>

        <input
          ref={importRef}
          type="file"
          accept=".jsonl,.json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void backups.importChat(file);
            event.target.value = '';
            setOpened(null);
          }}
        />
      </div>
    </ModelsProvider>
  );
}
