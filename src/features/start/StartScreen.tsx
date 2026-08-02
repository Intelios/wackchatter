import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary } from '@shared/types/chat.ts';
import { useEffect, useMemo, useState } from 'react';
import { type VersionInfo, characterApi, chatApi, versionApi } from '../../lib/api.ts';
import './StartScreen.css';

const COLLAPSED_COUNT = 3;
const MAX_RECENT = 15;

interface StartScreenProps {
  characters: CharacterSummary[];
  onOpenChat: (avatar: string, chatId: string) => void;
}

interface RecentChat extends ChatSummary {
  characterName: string;
  characterAvatar: string;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
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

function versionString(info: VersionInfo): string {
  let display = `WackChatter ${info.version}`;
  if (info.branch && info.revision) {
    display += ` '${info.branch}' (${info.revision})`;
  }
  return display;
}

export function StartScreen({ characters, onOpenChat }: StartScreenProps) {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [recent, setRecent] = useState<ChatSummary[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void versionApi
      .get()
      .then((info) => {
        if (!cancelled) setVersion(info);
      })
      .catch(() => {});
    void chatApi
      .recent(MAX_RECENT)
      .then((chats) => {
        if (!cancelled) setRecent(chats);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
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

  return (
    <div className="start-screen">
      <div className="start-screen__header">
        <h1 className="start-screen__title">WackChatter</h1>
        {version ? <span className="start-screen__version">{versionString(version)}</span> : null}
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
              <button
                key={chat.id}
                type="button"
                className="start-screen__chat"
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
                      {chat.messageCount > 0 ? `${chat.messageCount} msg · ` : ''}
                      {relativeTime(chat.modified)}
                    </span>
                  </div>
                </div>
              </button>
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
      </div>
    </div>
  );
}
