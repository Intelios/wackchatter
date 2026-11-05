/**
 * The 3.0 shell.
 *
 * Markup over the app controller, like `LegacyShell`, so it inherits every behaviour
 * unchanged. It covers the chat for now: the island and its wings, the margin, the
 * transcript and the Line. Everything it does not draw yet (the welcome screen, Studio,
 * the Co-Creators, Arena, Stats) still renders through the 2.x shell, so nothing is out of
 * reach while the rebuild catches up.
 */

import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/instrument-sans/index.css';
import './shell.css';
import './island.css';
import './stage.css';

import { greetingTexts } from '@shared/chat/message.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary } from '@shared/types/chat.ts';
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
import { ChatStage } from './ChatStage.tsx';
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
import type { LineHandle } from './LineComposer.tsx';
import {
  LEFT_TOOLS,
  MarginTool,
  RIGHT_TOOLS,
  TOOLS,
  type ToolId,
  toolSubtitle,
} from './MarginTools.tsx';
import { replay, useAura } from './useAura.ts';

export function Shell({
  controller,
  onUiChoice,
}: {
  controller: AppController;
  onUiChoice: (choice: UiChoice) => void;
}) {
  // Everything the shell does not draw yet goes through the 2.x one.
  if (controller.view !== 'app' || !controller.active || !controller.character) {
    return <LegacyShell controller={controller} />;
  }
  return <ChatShell controller={controller} onUiChoice={onUiChoice} />;
}

const BUSY = 'Wait for the current reply to finish.';

function ChatShell({
  controller,
  onUiChoice,
}: {
  controller: AppController;
  onUiChoice: (choice: UiChoice) => void;
}) {
  const { app, library, backups, chat } = controller;
  const { settings, view: prefs, models } = app;
  const active = controller.active!;
  const character = controller.character!;
  const { state } = chat;

  const rootRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const bloomRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<LineHandle>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const [tool, setTool] = useState<ToolId | null>(null);
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
      controller.editCharacter(active.avatar);
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

  // --- Generating ----------------------------------------------------------------------

  const generating = state.status !== 'idle';
  const summarising = chat.summaryStatus.running;
  const impersonating = generating && state.mode === 'impersonate';
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
      else if (status.total)
        say({ icon: 'memory', title: 'Memory', text: 'the summary is up to date' });
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
    () => firstSentence(chat.renderGreeting(description)),
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

  const searchItems = useMemo<SearchItem[]>(() => {
    const items: SearchItem[] = [];
    for (const summary of recentCharacters) {
      items.push({
        key: `c:${summary.avatar}`,
        kind: 'Character',
        label: summary.name,
        sub: summary.description.slice(0, 90),
        face: { name: summary.name, url: avatarUrlOf(summary.avatar) },
        run: () => controller.selectCharacter(summary.avatar),
      });
    }
    for (const summary of library.characters) {
      if (recentCharacters.includes(summary)) continue;
      items.push({
        key: `c:${summary.avatar}`,
        kind: 'Character',
        label: summary.name,
        sub: summary.description.slice(0, 90),
        face: { name: summary.name, url: avatarUrlOf(summary.avatar) },
        run: () => controller.selectCharacter(summary.avatar),
      });
    }
    for (const summary of chat.chats) {
      items.push({
        key: `chat:${summary.id}`,
        kind: 'Chat',
        label: summary.title,
        sub: `${characterName} · ${summary.messageCount} messages`,
        icon: 'chat',
        run: () => void chat.openChat(summary.id),
      });
    }
    for (const id of [...LEFT_TOOLS, ...RIGHT_TOOLS]) {
      items.push({
        key: `t:${id}`,
        kind: 'Tool',
        label: TOOLS[id].title,
        icon: TOOLS[id].icon,
        run: () => openTool(id),
      });
    }
    items.push(
      {
        key: 'a:studio',
        kind: 'App',
        label: 'Studio',
        sub: 'Organise and edit your library',
        icon: 'studio',
        run: () => void controller.enterStudio(),
      },
      {
        key: 'a:cocreator',
        kind: 'App',
        label: 'Co-Creator',
        sub: 'Write a character or preset with a model',
        icon: 'sparkles',
        run: () => void controller.enterCoCreator(),
      },
      {
        key: 'a:arena',
        kind: 'App',
        label: 'Model Arena',
        sub: 'Compare models blind',
        icon: 'arena',
        run: () => void controller.enterArena(),
      },
      {
        key: 'a:stats',
        kind: 'App',
        label: 'Stats',
        sub: 'Usage in TokenTrail',
        icon: 'stats',
        run: () => void controller.enterStats(),
      },
    );
    for (const p of library.personas) {
      items.push({
        key: `p:${p.id}`,
        kind: 'Persona',
        label: p.variantLabel ? `${p.name} (${p.variantLabel})` : p.name,
        sub: p.description.slice(0, 90),
        face: {
          name: p.name,
          url: p.avatar
            ? personaApi.avatarUrl(p.id, library.personaAvatarVersions[p.id] ?? p.avatar)
            : null,
          me: true,
        },
        run: () => controller.selectPersona(p.id),
      });
    }
    return items;
  }, [
    recentCharacters,
    library.characters,
    library.personas,
    library.personaAvatarVersions,
    chat.chats,
    chat.openChat,
    characterName,
    avatarUrlOf,
    controller,
    openTool,
  ]);

  // --- Margin ----------------------------------------------------------------------------

  const side = tool ? TOOLS[tool].side : null;
  const chooseModel = useCallback(() => openTool('generation'), [openTool]);

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
    >
      <div
        ref={rootRef}
        className="wc3"
        data-overlay-root
        data-margin={side ?? undefined}
        data-image={Boolean(backdropUrl)}
        data-generating={generating || undefined}
        style={
          {
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
              <ErrorBoundary
                where={TOOLS[tool].title}
                resetKeys={[tool, controller.editing, controller.selected]}
              >
                <MarginTool id={tool} controller={controller} onUiChoice={onUiChoice} />
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
          wingLeft={LEFT_TOOLS.map((id) => (
            <WingButton
              key={id}
              icon={TOOLS[id].icon}
              label={TOOLS[id].title}
              pressed={tool === id}
              onClick={() => openTool(id)}
            />
          ))}
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
                    ? 'Writing the summary'
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
                  controller.editCharacter(active.avatar);
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

/**
 * The first sentence of a description, for a one-line introduction. Cards written as
 * structured blocks (W++, JSON, `[Name's Personality= ...]`) have no sentence to offer,
 * and showing their syntax reads as a fault, so those give nothing.
 */
function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (/^[[{(<]/.test(clean) || /^.{0,60}[=:]\s*["\[{]/.test(clean)) return '';
  const match = /^(.{20,160}?[.!?])(\s|$)/.exec(clean);
  return match ? match[1]! : clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}
