import type { ComposerLabelMode, ComposerLayout } from '@shared/composer/layout.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type {
  DialogueColorOverride,
  DialogueColorSettings,
  GuidanceSettings,
  QuickCommand,
} from '@shared/types/settings.ts';
import { type ComponentProps, memo, type ReactNode, useCallback, useRef, useState } from 'react';
import {
  BoltIcon,
  BookIcon,
  BranchIcon,
  CardIcon,
  CloseIcon,
  ContinueIcon,
  DownloadIcon,
  MessagesIcon,
  NexusIcon,
  PlusIcon,
  RecapIcon,
  RefreshIcon,
  UserIcon,
} from '../../layout/icons.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { chatApi, personaApi } from '../../lib/api.ts';
import { downloadUrl } from '../../lib/download.ts';
import { PersonaChip } from '../persona/PersonaChip.tsx';
import { needsPortrait, resolveDialogueColor, useAvatarPalette } from './avatarColor.ts';
import { BranchTree } from './BranchTree.tsx';
import { CardReader } from './CardReader.tsx';
import { ChatMenu } from './ChatMenu.tsx';
import { Composer, type ComposerHandle } from './Composer.tsx';
import { ComposerImportControl, ComposerRenameControl } from './ComposerUtilityControls.tsx';
import { GuidesPopover } from './GuidesPopover.tsx';
import { MessageBubble } from './MessageBubble.tsx';
import { QuickCommands } from './QuickCommands.tsx';
import { RecapOverlay } from './RecapOverlay.tsx';
import type { UseChat } from './useChat.ts';
import { useChatSurface } from './useChatSurface.ts';
import './ChatView.css';

interface ChatViewProps {
  chat: UseChat;
  characterName: string;
  avatar: string | null;
  characterAvatarVersion?: number;
  /** Cache-busting versions per persona id — a row's speaker is not always the chat's. */
  personaAvatarVersions?: Readonly<Record<string, number>>;
  /** Every persona, for the composer's switcher and for resolving `/persona <name>`. */
  personas: Persona[];
  /** Most recently switched to, newest first. Orders the switcher. */
  recentPersonaIds: readonly string[];
  /** Sets the app-wide persona and this chat's, together. */
  onSelectPersona: (id: string | null) => void;
  /**
   * The card's `creator_notes` as stored, offered on the greeting. Empty shows nothing.
   * Macros are resolved here, on the display path, not by the caller.
   */
  creatorNotes: string;
  /** How many greetings the card offers, so a scenario list can be lined up with them. */
  greetingCount: number;
  /**
   * The open character's card, for the sheet on their avatar. Already in memory — the chat
   * cannot render without it — so reading it back costs no fetch.
   */
  card: CardDataV2 | null;
  /** Leaves the chat for the character editor, offered from inside the sheet. */
  onEditCharacter: () => void;
  /** False until the chat model can run and a preset is loaded. */
  ready: boolean;
  /** Why the chat model cannot run, when that is what keeps `ready` false. */
  notReadyReason?: string | null;
  /** Leave the chat and go back to the no-character state. */
  onCloseChat: () => void;
  /** Open the right panel on a given tab, for the menu's jump entries. */
  onOpenPanel: (panel: RightPanelId) => void;
  /** App-wide guided-generation config. The guides themselves live on the chat. */
  guidance: GuidanceSettings;
  onGuidanceChange: (patch: Partial<GuidanceSettings>) => void;
  dialogueColors: DialogueColorSettings;
  /** App-wide user-defined quick commands, inserted into the composer from the chat menu. */
  quickCommands: QuickCommand[];
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
  composerLayout: ComposerLayout;
  onComposerLayoutSave: (layout: ComposerLayout) => Promise<void>;
  /** Reads a chat export into this character as a new chat, from the chat menu. */
  onImportChat: (file: File) => void;
  /**
   * Enabled regex scripts. A lookup, not the settings object, for the same reason the
   * dialogue colours are: an unrelated settings change must not re-render the transcript.
   */
  regexScripts: readonly RegexScript[];
  /**
   * Chat-menu families the user has collapsed, by header key, and the write-back. Passed
   * straight through to the burger: the menu popup unmounts on close, so the choice has to
   * be owned above it to survive.
   */
  collapsedMenuGroups: readonly string[];
  onCollapsedMenuGroupsChange: (next: string[]) => void;
}

export function ChatView({
  chat,
  characterName,
  avatar,
  characterAvatarVersion,
  personaAvatarVersions,
  personas,
  recentPersonaIds,
  onSelectPersona,
  creatorNotes,
  greetingCount,
  card,
  onEditCharacter,
  ready,
  notReadyReason,
  onCloseChat,
  onOpenPanel,
  guidance,
  onGuidanceChange,
  dialogueColors,
  quickCommands,
  onQuickCommandsChange,
  composerLayout,
  onComposerLayoutSave,
  onImportChat,
  regexScripts,
  collapsedMenuGroups,
  onCollapsedMenuGroupsChange,
}: ChatViewProps) {
  // The write path from quick commands and impersonation into the composer's draft.
  const composerRef = useRef<ComposerHandle>(null);
  const { state, stream, busy, generationBlocked } = chat;
  const chatPersona = chat.persona;

  const {
    scrollRef,
    contentRef,
    flashId,
    visibleStart,
    visibleMessages,
    impersonating,
    loadBlocksChat,
    characterAvatarUrl,
    characterDialogue,
    speakerOf,
    cardStore,
    cardReader,
    openCardReader,
    closeCardReader,
    recapOpen,
    recapView,
    recapMeta,
    runRecap,
    closeRecap,
    impersonate,
    handleSend,
    guide,
    guidedSwipe,
    swipe,
    swipeTo,
    regenerate,
    continueLast,
    editMessage,
    editReasoning,
    deleteMessage,
    toggleHidden,
    branchFrom,
    editCharacter,
    lastId,
    awaitingReply,
    guides,
    guidedSwipeDisabledReason,
    displayTexts,
    renderedNotes,
  } = useChatSurface({
    chat,
    avatar,
    characterAvatarVersion,
    personas,
    onSelectPersona,
    onOpenPanel,
    creatorNotes,
    card,
    onEditCharacter,
    dialogueColors,
    regexScripts,
    onImpersonated: (text) => composerRef.current?.replace(text),
  });

  const controlButton = (
    label: string,
    icon: ReactNode,
    display: ComposerLabelMode,
    onClick: () => void,
    disabledReason?: string,
  ) => (
    <button
      type="button"
      className="wc-button wc-button--ghost composer__icon composer__layout-button"
      onClick={onClick}
      disabled={Boolean(disabledReason)}
      title={disabledReason ?? label}
      aria-label={label}
    >
      {icon}
      {display === 'label' ? <span>{label}</span> : null}
    </button>
  );

  // The branch timeline: the card reader's sibling takeover, one door (the chat menu).
  const [branchTreeOpen, setBranchTreeOpen] = useState(false);
  const openBranchTree = useCallback(() => setBranchTreeOpen(true), []);
  const closeBranchTree = useCallback(() => setBranchTreeOpen(false), []);

  return (
    <div className="chat-view">
      {/* Portals itself into the shell's overlay root, over the chat column. */}
      {cardReader ? (
        <CardReader
          store={cardStore}
          init={cardReader}
          onClose={closeCardReader}
          onEditCharacter={editCharacter}
          busy={busy}
        />
      ) : null}

      {/* Same takeover, for the branch family. Unmounts with the chat it is centred on. */}
      {branchTreeOpen && state.chatId ? <BranchTree chat={chat} onClose={closeBranchTree} /> : null}

      {/* The recap reads over the column, and survives a panel opening like the others. */}
      {recapOpen ? (
        <RecapOverlay
          view={recapView}
          meta={recapMeta}
          stream={stream}
          title={state.title}
          characterName={characterName}
          characterDialogueColor={characterDialogue.color}
          personaName={chatPersona?.name}
          episode={recapMeta?.total ?? state.messages.length}
          onClose={closeRecap}
        />
      ) : null}

      <div className="chat-view__scroll" ref={scrollRef}>
        <div className="chat-view__content" ref={contentRef}>
          {state.messages.length === 0 ? (
            <div className="wc-empty">
              <span>No messages yet. Say something to {characterName}.</span>
            </div>
          ) : (
            visibleMessages.map((message, index) => {
              const messageIndex = visibleStart + index;
              const shared = {
                message,
                streaming: state.streamingId === message.id,
                flash: message.id === flashId,
                mode: state.mode,
                stream,
                isLast: message.id === lastId,
                busy,
                summaryRunning: chat.summaryStatus.running,
                displayText: displayTexts.get(message.id)?.text,
                displayReasoning: displayTexts.get(message.id)?.reasoning,
                // Row 0 only: the notes explain which greeting you are looking at, and
                // nothing below the opening message is a greeting.
                creatorNotes: messageIndex === 0 ? renderedNotes : undefined,
                greetingCount: messageIndex === 0 ? greetingCount : undefined,
                onSwipe: swipe,
                onSwipeTo: swipeTo,
                onRegenerate: regenerate,
                onContinue: continueLast,
                onRetry: regenerate,
                onEdit: editMessage,
                onEditReasoning: editReasoning,
                onDelete: deleteMessage,
                onToggleHidden: toggleHidden,
                onBranch: branchFrom,
              };
              if (message.is_user) {
                const speaker = speakerOf(message);
                return (
                  <UserMessageBubble
                    key={message.id}
                    {...shared}
                    persona={speaker}
                    avatarVersion={speaker ? personaAvatarVersions?.[speaker.id] : undefined}
                    // Lookups, not the settings object: an unrelated settings change
                    // must not re-render every user row.
                    dialogueEnabled={dialogueColors.enabled}
                    override={speaker ? dialogueColors.personas[speaker.id] : undefined}
                  />
                );
              }
              return (
                <MessageBubble
                  key={message.id}
                  {...shared}
                  avatarUrl={characterAvatarUrl}
                  dialogueActive={characterDialogue.active}
                  dialogueColor={characterDialogue.color}
                  dialogueGradient={characterDialogue.gradient}
                  // Character rows only. A persona has no card, so a user row's avatar
                  // stays a picture rather than becoming a control that opens someone
                  // else's description.
                  cardStore={cardStore}
                  onEditCharacter={editCharacter}
                  onOpenCardReader={openCardReader}
                />
              );
            })
          )}
        </div>
      </div>

      {/*
        The dock: everything pinned below the transcript, OUTSIDE the scroll container.
        That placement is the anchor — a composer rendered inside `.chat-view__scroll`
        scrolls away with the messages, which is exactly the regression this undoes. It
        still grows with the draft; growth shrinks the transcript's viewport instead of
        extending a page, and `useStickToBottom` re-pins the bottom as it does, so the
        message above stays readable beside what you are typing.
      */}
      <div className="chat-view__dock">
        {state.error ? (
          <div className="chat-view__error" role="alert">
            <span className="chat-view__error-text">{state.error}</span>
            {/* The whole point of a failure notice: a way to try again without retyping. */}
            {awaitingReply ? (
              <button
                type="button"
                className="wc-button chat-view__retry"
                onClick={() => void chat.regenerate()}
                disabled={busy || !ready}
              >
                <RefreshIcon />
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        {chat.saveError ? (
          <div className="chat-view__error" role="alert">
            <span className="chat-view__error-text">
              Could not save this chat: {chat.saveError}
            </span>
            <button
              type="button"
              className="wc-button chat-view__retry"
              onClick={() => void chat.retrySave()}
              disabled={busy || chat.saving}
            >
              <RefreshIcon />
              Retry save
            </button>
          </div>
        ) : null}

        {chat.loadError ? (
          <div className="chat-view__error" role="alert">
            <span className="chat-view__error-text">
              Could not load this character's chats: {chat.loadError}
            </span>
            <button
              type="button"
              className="wc-button chat-view__retry"
              onClick={chat.retryLoad}
              disabled={busy}
            >
              <RefreshIcon />
              Retry load
            </button>
          </div>
        ) : null}

        <Composer
          key={state.chatId}
          ref={composerRef}
          onDraftChange={chat.nexus.draftChanged}
          onSend={handleSend}
          // The other two composer submits. Both put new text at the end of the transcript,
          // so both earn the same snap as an ordinary send.
          onGuide={guide}
          onGuidedSwipe={guidedSwipe}
          guidedSwipeDisabledReason={guidedSwipeDisabledReason}
          onImpersonate={impersonate}
          impersonating={impersonating}
          stream={stream}
          onStop={chat.summaryStatus.running ? chat.cancelSummary : chat.abort}
          busy={generationBlocked}
          disabled={!ready || loadBlocksChat}
          layout={composerLayout}
          onLayoutSave={onComposerLayoutSave}
          controls={[
            {
              id: 'persona',
              label: 'Persona',
              render: (display) => (
                <PersonaChip
                  compact={display === 'icon'}
                  personas={personas}
                  active={chat.persona}
                  recentIds={recentPersonaIds}
                  avatarVersions={personaAvatarVersions ?? {}}
                  onSelect={onSelectPersona}
                  onManage={() => onOpenPanel('persona')}
                />
              ),
            },
            {
              id: 'menu',
              label: 'Chat menu',
              render: (display) => (
                <ChatMenu
                  showLabel={display === 'label'}
                  chat={chat}
                  onCloseChat={onCloseChat}
                  onOpenPanel={onOpenPanel}
                  onImportChat={onImportChat}
                  onOpenCard={openCardReader}
                  onOpenBranchTree={openBranchTree}
                  onOpenRecap={runRecap}
                  onCustomiseComposer={() => composerRef.current?.customise()}
                  onComposerAction={(id) => composerRef.current?.activate(id)}
                  collapsedMenuGroups={collapsedMenuGroups}
                  onCollapsedMenuGroupsChange={onCollapsedMenuGroupsChange}
                />
              ),
            },
            {
              id: 'quickCommands',
              label: 'Quick commands',
              render: (display) => (
                <QuickCommands
                  showLabel={display === 'label'}
                  quickCommands={quickCommands}
                  onInsertCommand={(text) => composerRef.current?.insert(text)}
                  onQuickCommandsChange={onQuickCommandsChange}
                />
              ),
            },
            {
              id: 'nexus',
              label: 'Memory Nexus',
              render: (display) =>
                controlButton(
                  'Memory Nexus',
                  <NexusIcon />,
                  display,
                  () => chat.nexus.show('explore'),
                  chat.memoryMode === 'nexus' ? undefined : 'This chat is not using Memory Nexus.',
                ),
            },
            {
              id: 'guides',
              label: 'Persistent guides',
              render: (display) => (
                <GuidesPopover
                  showLabel={display === 'label'}
                  guides={guides}
                  onGuidesChange={(next) => chat.updateMetadata({ guides: next })}
                  guidance={guidance}
                  onGuidanceChange={onGuidanceChange}
                  disabled={!state.chatId}
                />
              ),
            },
            {
              id: 'recap',
              label: 'Previously on',
              render: (display) =>
                controlButton(
                  'Previously on',
                  <RecapIcon />,
                  display,
                  runRecap,
                  generationBlocked
                    ? 'Wait for the current operation to finish.'
                    : state.messages.length
                      ? undefined
                      : 'This chat has no messages yet.',
                ),
            },
            {
              id: 'newChat',
              label: 'New chat',
              render: (display) =>
                controlButton(
                  'New chat',
                  <PlusIcon />,
                  display,
                  () => void chat.newChat(),
                  busy ? 'Wait for the current reply to finish.' : undefined,
                ),
            },
            {
              id: 'rename',
              label: 'Rename chat',
              render: (display) => (
                <ComposerRenameControl
                  title={state.title}
                  display={display}
                  disabledReason={
                    busy
                      ? 'Wait for the current reply to finish.'
                      : !state.chatId
                        ? 'No chat is open.'
                        : undefined
                  }
                  onRename={(title) => void chat.renameChat(title)}
                />
              ),
            },
            {
              id: 'export',
              label: 'Export chat',
              render: (display) =>
                controlButton(
                  'Export chat',
                  <DownloadIcon />,
                  display,
                  () => state.chatId && downloadUrl(chatApi.exportUrl(state.chatId)),
                  busy
                    ? 'Wait for the current reply to finish.'
                    : !state.chatId
                      ? 'No chat is open.'
                      : undefined,
                ),
            },
            {
              id: 'import',
              label: 'Import chat',
              render: (display) => (
                <ComposerImportControl
                  display={display}
                  disabledReason={busy ? 'Wait for the current reply to finish.' : undefined}
                  onImport={onImportChat}
                />
              ),
            },
            {
              id: 'checkpoint',
              label: 'Save checkpoint',
              render: (display) =>
                controlButton(
                  'Save checkpoint',
                  <BranchIcon />,
                  display,
                  () => lastId && void chat.branchFrom(lastId),
                  busy
                    ? 'Wait for the current reply to finish.'
                    : !lastId
                      ? 'This chat has no messages yet.'
                      : undefined,
                ),
            },
            {
              id: 'regenerate',
              label: 'Regenerate',
              render: (display) =>
                controlButton(
                  'Regenerate',
                  <RefreshIcon />,
                  display,
                  () => void chat.regenerate(),
                  generationBlocked
                    ? 'Wait for the current operation to finish.'
                    : !lastId
                      ? 'This chat has no messages yet.'
                      : undefined,
                ),
            },
            {
              id: 'continue',
              label: 'Continue',
              render: (display) =>
                controlButton(
                  'Continue',
                  <ContinueIcon />,
                  display,
                  () => void chat.continueLast(),
                  generationBlocked
                    ? 'Wait for the current operation to finish.'
                    : !lastId
                      ? 'This chat has no messages yet.'
                      : awaitingReply
                        ? 'The last message is yours.'
                        : undefined,
                ),
            },
            {
              id: 'card',
              label: 'Character card',
              render: (display) =>
                controlButton('Character card', <CardIcon />, display, () => openCardReader()),
            },
            {
              id: 'branches',
              label: 'Branch timeline',
              render: (display) =>
                controlButton(
                  'Branch timeline',
                  <BranchIcon />,
                  display,
                  openBranchTree,
                  state.chatId ? undefined : 'No chat is open.',
                ),
            },
            {
              id: 'context',
              label: 'Chat context',
              render: (display) =>
                controlButton('Chat context', <MessagesIcon />, display, () =>
                  onOpenPanel('characters'),
                ),
            },
            {
              id: 'lore',
              label: 'Lore',
              render: (display) =>
                controlButton('Lore', <BookIcon />, display, () => onOpenPanel('lorebooks')),
            },
            {
              id: 'personas',
              label: 'Personas',
              render: (display) =>
                controlButton('Personas', <UserIcon />, display, () => onOpenPanel('persona')),
            },
            {
              id: 'close',
              label: 'Close chat',
              render: (display) =>
                controlButton(
                  'Close chat',
                  <CloseIcon />,
                  display,
                  onCloseChat,
                  busy ? 'Wait for the current reply to finish.' : undefined,
                ),
            },
            ...quickCommands
              .filter((command) => command.text.trim())
              .map((command) => ({
                id: `quick:${command.id}`,
                label: command.name.trim() || command.text.trim().slice(0, 32),
                render: (display: ComposerLabelMode) =>
                  controlButton(command.name.trim() || 'Quick command', <BoltIcon />, display, () =>
                    composerRef.current?.insert(command.text),
                  ),
              })),
          ]}
          placeholder={
            loadBlocksChat
              ? 'Retry loading this character before sending a message.'
              : ready
                ? `Message ${characterName}…`
                : `${notReadyReason ?? 'Choose a chat model.'} The chat model is set in Connections.`
          }
        />
      </div>
    </div>
  );
}

type UserMessageBubbleProps = Omit<
  ComponentProps<typeof MessageBubble>,
  'avatarUrl' | 'dialogueActive' | 'dialogueColor' | 'dialogueGradient'
> & {
  /** The persona this message was sent as, already resolved from its recorded id. */
  persona: Persona | null;
  avatarVersion: number | undefined;
  dialogueEnabled: boolean;
  /** This speaker's colour override, if any. */
  override: DialogueColorOverride | undefined;
};

/**
 * A user row with its speaker's presentation resolved per message.
 *
 * The avatar-colour extraction is a hook, so it cannot run in the transcript loop for an
 * arbitrary number of speakers — it lives here, one leaf per row. Repeat rows for one
 * persona hit the module-level colour cache, so the extraction still runs once per avatar.
 */
const UserMessageBubble = memo(function UserMessageBubble({
  persona,
  avatarVersion,
  dialogueEnabled,
  override,
  ...rest
}: UserMessageBubbleProps) {
  // Keyed on the filename so replacing the image busts the cache instead of showing the
  // old one until a reload.
  const avatarUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, avatarVersion ?? persona.avatar)
    : null;
  const autoColor = useAvatarPalette(dialogueEnabled && needsPortrait(override) ? avatarUrl : null);
  const dialogue = resolveDialogueColor(dialogueEnabled, override, autoColor);

  return (
    <MessageBubble
      {...rest}
      avatarUrl={avatarUrl}
      dialogueActive={dialogue.active}
      dialogueColor={dialogue.color}
      dialogueGradient={dialogue.gradient}
    />
  );
});
