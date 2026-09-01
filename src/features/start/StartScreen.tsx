import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary } from '@shared/types/chat.ts';
import { useEffect, useMemo, useState } from 'react';
import {
  ArenaIcon,
  CoCreatorIcon,
  MessagesIcon,
  StatsIcon,
  StudioIcon,
  TrashIcon,
} from '../../layout/icons.tsx';
import { characterApi, chatApi, type VersionInfo, versionApi } from '../../lib/api.ts';
import { versionString } from './versionString.ts';
import './StartScreen.css';

const COLLAPSED_COUNT = 3;
const MAX_RECENT = 15;

interface StartScreenProps {
  characters: CharacterSummary[];
  onOpenChat: (avatar: string, chatId: string) => void;
  onDeleteChat: (chatId: string) => Promise<void>;
  onOpenStudio: () => void;
  onOpenCoCreator: () => void;
  onOpenStats: () => void;
  onOpenArena: () => void;
}

interface RecentChat extends ChatSummary {
  characterName: string;
  characterAvatar: string;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 1000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: days >= 365 ? 'numeric' : undefined,
  });
}

export function StartScreen({
  characters,
  onOpenChat,
  onDeleteChat,
  onOpenStudio,
  onOpenCoCreator,
  onOpenStats,
  onOpenArena,
}: StartScreenProps) {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [recent, setRecent] = useState<ChatSummary[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => {
      setConfirming(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  useEffect(() => {
    let cancelled = false;
    const refreshVersion = () => {
      void versionApi
        .get()
        .then((info) => {
          if (!cancelled) setVersion(info);
        })
        .catch(() => {});
    };
    refreshVersion();
    // The Start screen can sit mounted for days; refetching when the window comes back
    // gives the server's TTL a chance to matter. It decides whether work happens.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshVersion();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void chatApi
      .recent(MAX_RECENT)
      .then((chats) => {
        if (!cancelled) setRecent(chats);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const byAvatar = useMemo(() => {
    const map = new Map<string, CharacterSummary>();
    for (const character of characters) map.set(character.avatar, character);
    return map;
  }, [characters]);

  const enriched: RecentChat[] = useMemo(() => {
    if (!recent) return [];
    return recent.map((chat) => {
      const character = byAvatar.get(chat.characterId);
      return {
        ...chat,
        characterName: character?.name ?? chat.characterId,
        characterAvatar: chat.characterId,
      };
    });
  }, [recent, byAvatar]);

  const visible = expanded ? enriched : enriched.slice(0, COLLAPSED_COUNT);
  const hasMore = enriched.length > COLLAPSED_COUNT;

  async function handleDelete(chatId: string) {
    setConfirming(null);
    await onDeleteChat(chatId);
    // Refetch rather than splice: a failed delete must leave the row in place, and the
    // error itself is surfaced by the app's error banner.
    try {
      setRecent(await chatApi.recent(MAX_RECENT));
    } catch {
      // Keep the last good list.
    }
  }

  return (
    <div className="start-screen">
      <div className="start-screen__header">
        <h1 className="start-screen__title">
          Wack<span className="start-screen__title-accent">Chatter</span>
        </h1>
        {version ? (
          <span
            className="start-screen__version"
            title={version.commitsBehind ? 'Run ./update.sh to update' : undefined}
          >
            {versionString(version)}
          </span>
        ) : null}
      </div>

      <div className="start-screen__recent">
        <h2 className="start-screen__recent-title">Recent Chats</h2>

        {recent === null ? (
          <p className="start-screen__empty">Loading…</p>
        ) : enriched.length === 0 ? (
          <p className="start-screen__empty">No chats yet. Select a character to begin.</p>
        ) : (
          <div className="start-screen__list">
            {visible.map((chat) => (
              <div key={chat.id} className="start-screen__chat">
                <button
                  type="button"
                  className="start-screen__chat-open"
                  onClick={() => onOpenChat(chat.characterAvatar, chat.id)}
                >
                  <img
                    className="start-screen__chat-avatar"
                    src={characterApi.imageUrl(chat.characterAvatar)}
                    alt=""
                  />
                  <div className="start-screen__chat-info">
                    <div className="start-screen__chat-name">
                      <strong>{chat.characterName}</strong>
                      <span className="start-screen__chat-sep">–</span>
                      <span>{chat.title}</span>
                    </div>
                    <div className="start-screen__chat-preview">
                      {chat.lastMessage ? (
                        <span className="start-screen__chat-message">{chat.lastMessage}</span>
                      ) : null}
                      <span className="start-screen__chat-meta">
                        <span>{relativeTime(chat.modified)}</span>
                        {chat.messageCount > 0 ? (
                          <span
                            className="start-screen__chat-count"
                            title={`${chat.messageCount} messages`}
                          >
                            <MessagesIcon />
                            <span className="start-screen__chat-count-num">
                              {chat.messageCount}
                            </span>
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  className="wc-button wc-button--ghost wc-button--danger start-screen__chat-delete"
                  data-confirming={confirming === chat.id}
                  onClick={() =>
                    confirming === chat.id ? void handleDelete(chat.id) : setConfirming(chat.id)
                  }
                  onBlur={() => setConfirming(null)}
                  title={confirming === chat.id ? 'Click again to delete' : 'Delete this chat'}
                  aria-label={
                    confirming === chat.id
                      ? 'Click again to delete'
                      : `Delete chat with ${chat.characterName}`
                  }
                >
                  <TrashIcon className="start-screen__chat-delete-icon" />
                  {confirming === chat.id ? (
                    <span className="start-screen__chat-delete-label">Delete?</span>
                  ) : null}
                </button>
              </div>
            ))}

            {hasMore ? (
              <button
                type="button"
                className="start-screen__toggle"
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? 'Show less' : `Show ${enriched.length - COLLAPSED_COUNT} more`}
              </button>
            ) : null}
          </div>
        )}

        {/*
         * Two pairs, and the grouping is the point rather than the wrapping: the top row
         * makes characters, the bottom row measures things. The rows are explicit so the
         * shape survives a narrow window instead of reflowing into an arbitrary four.
         */}
        <div className="start-screen__tool-links">
          <div className="start-screen__tool-pair">
            <button type="button" className="wc-button start-screen__tool" onClick={onOpenStudio}>
              <StudioIcon />
              Character Creator Studio
            </button>
            <button
              type="button"
              className="wc-button start-screen__tool"
              onClick={onOpenCoCreator}
            >
              <CoCreatorIcon />
              Character Co-Creator
            </button>
          </div>
          <div className="start-screen__tool-pair">
            <button type="button" className="wc-button start-screen__tool" onClick={onOpenArena}>
              <ArenaIcon />
              Model Arena
            </button>
            <button type="button" className="wc-button start-screen__tool" onClick={onOpenStats}>
              <StatsIcon />
              Stats
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
