import type { CocreatorSessionSummary } from '@shared/types/cocreator.ts';
import { useState } from 'react';
import { PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { cocreatorApi } from '../../lib/api.ts';

interface CocreatorSessionsProps {
  sessions: readonly CocreatorSessionSummary[];
  loading: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
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
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function slotLabel(count: number): string {
  if (count === 0) return 'nothing filed yet';
  return count === 1 ? '1 slot filled' : `${count} slots filled`;
}

/** The Co-Creator's front door: pick up an old design conversation, or start a new one. */
export function CocreatorSessions({
  sessions,
  loading,
  onOpen,
  onCreate,
  onDelete,
}: CocreatorSessionsProps) {
  // Two-click confirm in place, cleared on blur — the app's destructive-action idiom.
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="cocreator-sessions">
      <div className="cocreator-sessions__hero">
        <div>
          <p className="cocreator-sessions__eyebrow">Character Co-Creator</p>
          <h1>Design a card in conversation.</h1>
          <p>Work an idea out with a model, file the parts you like, and finish into the Studio.</p>
        </div>
        <button type="button" className="wc-button wc-button--primary" onClick={onCreate}>
          <PlusIcon />
          New session
        </button>
      </div>

      {loading ? (
        <p className="wc-empty">Loading sessions…</p>
      ) : sessions.length === 0 ? (
        <p className="wc-empty">
          No design sessions yet. Start one and describe the character you have in mind.
        </p>
      ) : (
        <div className="cocreator-sessions__list">
          {sessions.map((session) => (
            <div key={session.id} className="cocreator-session">
              <button
                type="button"
                className="cocreator-session__open"
                onClick={() => onOpen(session.id)}
              >
                {session.avatar ? (
                  <img
                    className="cocreator-session__avatar"
                    src={cocreatorApi.avatarUrl(session.id, session.modified)}
                    alt=""
                  />
                ) : (
                  <span className="cocreator-session__avatar cocreator-session__avatar--empty" />
                )}
                <span className="cocreator-session__info">
                  <span className="cocreator-session__title">
                    <strong>{session.title}</strong>
                    {session.finishedAvatar ? (
                      <span className="cocreator-session__finished">finished</span>
                    ) : null}
                  </span>
                  {session.lastMessage ? (
                    <span className="cocreator-session__preview">{session.lastMessage}</span>
                  ) : null}
                  <span className="cocreator-session__meta">
                    <span>{relativeTime(session.modified)}</span>
                    <span>
                      {session.messageCount === 1 ? '1 turn' : `${session.messageCount} turns`}
                    </span>
                    <span>{slotLabel(session.stashedSlots)}</span>
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="wc-button wc-button--ghost wc-button--danger"
                data-confirming={confirming === session.id}
                onClick={() =>
                  confirming === session.id ? onDelete(session.id) : setConfirming(session.id)
                }
                onBlur={() => setConfirming(null)}
                title={
                  confirming === session.id ? 'Click again to delete' : 'Delete this design session'
                }
                aria-label={
                  confirming === session.id
                    ? 'Click again to delete'
                    : `Delete session ${session.title}`
                }
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
