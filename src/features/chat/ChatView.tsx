import { useCallback, useEffect, useMemo, useRef } from 'react';
import { RefreshIcon } from '../../layout/icons.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { characterApi, personaApi } from '../../lib/api.ts';
import { ChatMenu } from './ChatMenu.tsx';
import { Composer } from './Composer.tsx';
import { MessageBubble } from './MessageBubble.tsx';
import type { UseChat } from './useChat.ts';
import { useStickToBottom } from './useStickToBottom.ts';
import './ChatView.css';

interface ChatViewProps {
  chat: UseChat;
  characterName: string;
  avatar: string | null;
  /** False until an endpoint and model are configured. */
  ready: boolean;
  /** Leave the chat and go back to the no-character state. */
  onCloseChat: () => void;
  /** Open the right panel on a given tab, for the menu's jump entries. */
  onOpenPanel: (panel: RightPanelId) => void;
}

export function ChatView({
  chat,
  characterName,
  avatar,
  ready,
  onCloseChat,
  onOpenPanel,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom } = useStickToBottom(scrollRef, contentRef);

  const { state, stream, busy } = chat;
  const loadBlocksChat = Boolean(chat.loadError && !state.chatId);
  const characterAvatarUrl = avatar ? characterApi.imageUrl(avatar) : null;

  // Who "you" are in this chat has a face too. Keyed on the filename so replacing the
  // image busts the cache instead of showing the old one until a reload.
  const persona = chat.persona;
  const personaAvatarUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, persona.avatar)
    : null;

  // Jump to the end when a different chat is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the chat, by design
  useEffect(() => {
    scrollToBottom();
  }, [state.chatId]);

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
  const deleteMessage = useCallback((id: string) => chat.deleteMessage(id), [chat]);
  const toggleHidden = useCallback((id: string) => chat.toggleHidden(id), [chat]);
  const branchFrom = useCallback((id: string) => void chat.branchFrom(id), [chat]);

  const lastId = state.messages[state.messages.length - 1]?.id ?? null;
  // A transcript ending on the user's turn is one still owed a reply — after a failure,
  // an abort, or deleting the reply. That is what makes retry available.
  const awaitingReply = Boolean(state.messages[state.messages.length - 1]?.is_user);

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
            state.messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                avatarUrl={message.is_user ? personaAvatarUrl : characterAvatarUrl}
                streaming={state.streamingId === message.id}
                stream={stream}
                isLast={message.id === lastId}
                busy={busy}
                displayText={index === 0 ? greeting : undefined}
                onSwipe={swipe}
                onRegenerate={regenerate}
                onContinue={continueLast}
                onRetry={regenerate}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onToggleHidden={toggleHidden}
                onBranch={branchFrom}
              />
            ))
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
        onStop={chat.abort}
        busy={busy}
        disabled={!ready || loadBlocksChat}
        // Deliberately not gated on `ready`: closing or starting a chat has to work
        // before a connection is configured.
        leading={<ChatMenu chat={chat} onCloseChat={onCloseChat} onOpenPanel={onOpenPanel} />}
        placeholder={
          loadBlocksChat
            ? 'Retry loading this character before sending a message.'
            : ready
              ? `Message ${characterName}…`
              : 'Configure an endpoint and model in Settings → Connection first.'
        }
      />
    </div>
  );
}
