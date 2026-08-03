import type { DialogueColorSettings, GuidanceSettings } from '@shared/types/settings.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RefreshIcon } from '../../layout/icons.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { characterApi, personaApi } from '../../lib/api.ts';
import { resolveDialogueColor, useAvatarColor } from './avatarColor.ts';
import { ChatMenu } from './ChatMenu.tsx';
import { Composer } from './Composer.tsx';
import { GuidesPopover } from './GuidesPopover.tsx';
import { MessageBubble } from './MessageBubble.tsx';
import {
  initialTranscriptStart,
  prependTranscriptPage,
  TRANSCRIPT_PAGE_SIZE,
} from './transcriptWindow.ts';
import type { UseChat } from './useChat.ts';
import { useStickToBottom } from './useStickToBottom.ts';
import './ChatView.css';

interface ChatViewProps {
  chat: UseChat;
  characterName: string;
  avatar: string | null;
  characterAvatarVersion?: number;
  personaAvatarVersion?: number;
  /** False until an endpoint and model are configured. */
  ready: boolean;
  /** Leave the chat and go back to the no-character state. */
  onCloseChat: () => void;
  /** Open the right panel on a given tab, for the menu's jump entries. */
  onOpenPanel: (panel: RightPanelId) => void;
  /** App-wide guided-generation config. The guides themselves live on the chat. */
  guidance: GuidanceSettings;
  onGuidanceChange: (patch: Partial<GuidanceSettings>) => void;
  dialogueColors: DialogueColorSettings;
}

export function ChatView({
  chat,
  characterName,
  avatar,
  characterAvatarVersion,
  personaAvatarVersion,
  ready,
  onCloseChat,
  onOpenPanel,
  guidance,
  onGuidanceChange,
  dialogueColors,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom } = useStickToBottom(scrollRef, contentRef);
  const [window, setWindow] = useState({ chatId: null as string | null, start: 0 });
  const restorePrependScroll = useRef<{ height: number; top: number } | null>(null);

  const { state, stream, busy, generationBlocked } = chat;
  const loadBlocksChat = Boolean(chat.loadError && !state.chatId);
  const characterAvatarUrl = avatar ? characterApi.imageUrl(avatar, characterAvatarVersion) : null;

  // Who "you" are in this chat has a face too. Keyed on the filename so replacing the
  // image busts the cache instead of showing the old one until a reload.
  const persona = chat.persona;
  const personaAvatarUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, personaAvatarVersion ?? persona.avatar)
    : null;
  const characterOverride = avatar ? dialogueColors.characters[avatar] : undefined;
  const personaOverride = persona ? dialogueColors.personas[persona.id] : undefined;
  const characterAutoColor = useAvatarColor(
    dialogueColors.enabled && characterOverride === undefined ? characterAvatarUrl : null,
  );
  const personaAutoColor = useAvatarColor(
    dialogueColors.enabled && personaOverride === undefined ? personaAvatarUrl : null,
  );
  const characterDialogue = resolveDialogueColor(
    dialogueColors.enabled,
    characterOverride,
    characterAutoColor,
  );
  const personaDialogue = resolveDialogueColor(
    dialogueColors.enabled,
    personaOverride,
    personaAutoColor,
  );

  // Jump to the end when a different chat is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the chat, by design
  useEffect(() => {
    setWindow({ chatId: state.chatId, start: initialTranscriptStart(state.messages.length) });
    scrollToBottom();
  }, [state.chatId]);

  // A chat can render its loaded messages before the chat-change effect has set state.
  // Deriving the initial tail page here prevents that first paint from mounting every
  // Markdown bubble in a long chat.
  const visibleStart =
    window.chatId === state.chatId
      ? Math.min(window.start, state.messages.length)
      : initialTranscriptStart(state.messages.length);
  const visibleMessages = state.messages.slice(visibleStart);

  // Prepending adds DOM above the reader. Restore the same document position after the
  // layout commits, rather than leaving them unexpectedly at the oldest newly loaded row.
  useLayoutEffect(() => {
    const restore = restorePrependScroll.current;
    const scroll = scrollRef.current;
    if (!restore || !scroll) return;
    scroll.scrollTop = restore.top + scroll.scrollHeight - restore.height;
    restorePrependScroll.current = null;
  });

  function loadOlderMessages() {
    const scroll = scrollRef.current;
    if (scroll) {
      restorePrependScroll.current = { height: scroll.scrollHeight, top: scroll.scrollTop };
    }
    setWindow((current) => ({
      chatId: state.chatId,
      start: prependTranscriptPage(
        current.chatId === state.chatId
          ? current.start
          : initialTranscriptStart(state.messages.length),
      ),
    }));
  }

  /*
   * Hoisted so `memo` on MessageBubble is worth anything.
   *
   * Recreating these inline gives every row a new prop identity on every render, which
   * makes the memo compare unequal every time and re-render the whole transcript. Keyed on
   * the message id rather than closed over the message, so one stable callback serves
   * every row.
   */
  const swipe = useCallback((direction: -1 | 1) => void chat.swipe(direction), [chat]);
  const regenerate = useCallback(() => void chat.regenerate(), [chat]);
  const continueLast = useCallback(() => void chat.continueLast(), [chat]);
  const editMessage = useCallback((id: string, text: string) => chat.editMessage(id, text), [chat]);
  const editReasoning = useCallback(
    (id: string, reasoning: string) => chat.editReasoning(id, reasoning),
    [chat],
  );
  const deleteMessage = useCallback((id: string) => chat.deleteMessage(id), [chat]);
  const toggleHidden = useCallback((id: string) => chat.toggleHidden(id), [chat]);
  const branchFrom = useCallback((id: string) => void chat.branchFrom(id), [chat]);

  const lastId = state.messages[state.messages.length - 1]?.id ?? null;
  // A transcript ending on the user's turn is one still owed a reply — after a failure,
  // an abort, or deleting the reply. That is what makes retry available.
  const awaitingReply = Boolean(state.messages[state.messages.length - 1]?.is_user);

  const guides = state.metadata.guides ?? [];
  // Guided swipe needs a reply to make an alternate of. Both cases really do differ from
  // "no chat", so they get their own reasons rather than one vague "unavailable".
  const guidedSwipeDisabledReason = !lastId
    ? 'Nothing to swipe yet.'
    : awaitingReply
      ? 'Waiting on a reply — guide it instead.'
      : undefined;

  // The greeting renders its macros fresh, which would hand row 0 a new string on every
  // render and single-handedly defeat its memo.
  const first = state.messages[0];
  const greeting = useMemo(
    () =>
      first && !first.is_user ? chat.renderGreeting(first.swipes[first.swipe_id] ?? '') : undefined,
    [chat, first],
  );

  return (
    <div className="chat-view">
      <div className="chat-view__scroll" ref={scrollRef}>
        <div className="chat-view__content" ref={contentRef}>
          {state.messages.length === 0 ? (
            <div className="wc-empty">
              <span>No messages yet. Say something to {characterName}.</span>
            </div>
          ) : (
            <>
              {visibleStart > 0 ? (
                <button
                  type="button"
                  className="wc-button wc-button--ghost chat-view__load-older"
                  onClick={loadOlderMessages}
                >
                  Load {Math.min(visibleStart, TRANSCRIPT_PAGE_SIZE)} older messages
                </button>
              ) : null}
              {visibleMessages.map((message, index) => {
                const messageIndex = visibleStart + index;
                return (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    avatarUrl={message.is_user ? personaAvatarUrl : characterAvatarUrl}
                    dialogueActive={
                      message.is_user ? personaDialogue.active : characterDialogue.active
                    }
                    dialogueColor={
                      message.is_user ? personaDialogue.color : characterDialogue.color
                    }
                    streaming={state.streamingId === message.id}
                    mode={state.mode}
                    stream={stream}
                    isLast={message.id === lastId}
                    busy={busy}
                    summaryRunning={chat.summaryStatus.running}
                    displayText={messageIndex === 0 ? greeting : undefined}
                    onSwipe={swipe}
                    onRegenerate={regenerate}
                    onContinue={continueLast}
                    onRetry={regenerate}
                    onEdit={editMessage}
                    onEditReasoning={editReasoning}
                    onDelete={deleteMessage}
                    onToggleHidden={toggleHidden}
                    onBranch={branchFrom}
                  />
                );
              })}
            </>
          )}
        </div>
      </div>

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
          <span className="chat-view__error-text">Could not save this chat: {chat.saveError}</span>
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
        onSend={(text) => void chat.send(text)}
        onGuide={(text) => void chat.guidedRespond(text)}
        onGuidedSwipe={(text) => void chat.guidedSwipe(text)}
        guidedSwipeDisabledReason={guidedSwipeDisabledReason}
        onStop={chat.summaryStatus.running ? chat.cancelSummary : chat.abort}
        busy={generationBlocked}
        disabled={!ready || loadBlocksChat}
        // Deliberately not gated on `ready`: closing or starting a chat has to work
        // before a connection is configured.
        leading={
          <>
            <ChatMenu chat={chat} onCloseChat={onCloseChat} onOpenPanel={onOpenPanel} />
            <GuidesPopover
              guides={guides}
              onGuidesChange={(next) => chat.updateMetadata({ guides: next })}
              guidance={guidance}
              onGuidanceChange={onGuidanceChange}
              disabled={!state.chatId}
            />
          </>
        }
        placeholder={
          loadBlocksChat
            ? 'Retry loading this character before sending a message.'
            : ready
              ? `Message ${characterName}…`
              : 'Configure an endpoint and model in the Connections panel first.'
        }
      />
    </div>
  );
}
