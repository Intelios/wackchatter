import { useEffect, useRef } from 'react';
import { RefreshIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
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
}

export function ChatView({ chat, characterName, avatar, ready }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { scrollToBottom } = useStickToBottom(scrollRef, contentRef);

  const { state, stream, busy } = chat;
  const avatarUrl = avatar ? characterApi.imageUrl(avatar) : null;

  // Jump to the end when a different chat is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the chat, by design
  useEffect(() => {
    scrollToBottom();
  }, [state.chatId]);

  const lastId = state.messages[state.messages.length - 1]?.id ?? null;
  // A transcript ending on the user's turn is one still owed a reply — after a failure,
  // an abort, or deleting the reply. That is what makes retry available.
  const awaitingReply = Boolean(state.messages[state.messages.length - 1]?.is_user);

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
                avatarUrl={avatarUrl}
                streaming={state.streamingId === message.id}
                stream={stream}
                isLast={message.id === lastId}
                busy={busy}
                displayText={
                  index === 0 && !message.is_user
                    ? chat.renderGreeting(message.swipes[message.swipe_id] ?? '')
                    : undefined
                }
                onSwipe={(direction) => void chat.swipe(direction)}
                onRegenerate={() => void chat.regenerate()}
                onContinue={() => void chat.continueLast()}
                onRetry={() => void chat.regenerate()}
                onEdit={(text) => chat.editMessage(message.id, text)}
                onDelete={() => chat.deleteMessage(message.id)}
                onToggleHidden={() => chat.toggleHidden(message.id)}
                onBranch={() => void chat.branchFrom(message.id)}
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

      <Composer
        onSend={(text) => void chat.send(text)}
        onStop={chat.abort}
        busy={busy}
        disabled={!ready}
        placeholder={
          ready
            ? `Message ${characterName}…`
            : 'Configure an endpoint and model in Settings → Connection first.'
        }
      />
    </div>
  );
}
