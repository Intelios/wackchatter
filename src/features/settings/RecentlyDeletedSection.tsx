/**
 * The chat trash bin.
 *
 * Deleting a chat backs it up rather than dropping it, and this is where the backups wait.
 * It sits in User Settings beside the data location for the reason given there: a
 * destination is a claim about how often you need something, and you go looking for a
 * deleted chat about as often as you move your library. Being here also lets it be what it
 * actually is — one bin across every character — rather than the per-character slice the
 * chat panel used to show.
 *
 * Restore is a move, not a copy: the chat comes back under a fresh id, opens, and the slot
 * empties. Purge is the only irreversible button in the panel, so it takes two clicks.
 */

import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatBackupSummary } from '@shared/types/chat.ts';
import { useMemo, useState } from 'react';
import { Section } from '../../components/Section.tsx';
import { MessagesIcon, TrashIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import './RecentlyDeletedSection.css';

interface RecentlyDeletedSectionProps {
  backups: ChatBackupSummary[];
  /** The library, for turning an avatar filename into a name and a face. */
  characters: CharacterSummary[];
  onRestore: (backupId: string) => void;
  onPurge: (backupId: string) => void;
  onPurgeAll?: () => void;
}

function deletedLabel(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function RecentlyDeletedSection({
  backups,
  characters,
  onRestore,
  onPurge,
  onPurgeAll,
}: RecentlyDeletedSectionProps) {
  const [purging, setPurging] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const byAvatar = useMemo(() => {
    const map = new Map<string, CharacterSummary>();
    for (const character of characters) map.set(character.avatar, character);
    return map;
  }, [characters]);

  return (
    <Section title="Recently deleted" badge={backups.length > 0 ? backups.length : undefined}>
      {backups.length === 0 ? (
        <p className="wc-hint">
          Nothing here. Deleted chats wait in this bin instead of going straight out.
        </p>
      ) : (
        <>
          <div className="bin__toolbar">
            {confirmingAll ? (
              <div className="bin__confirm-banner" role="alert">
                <p className="bin__confirm-text">
                  Permanently delete all {backups.length}{' '}
                  {backups.length === 1 ? 'backup' : 'backups'}? This cannot be undone.
                </p>
                <div className="bin__confirm-actions">
                  <button
                    type="button"
                    className="wc-button wc-button--danger"
                    onClick={() => {
                      setConfirmingAll(false);
                      onPurgeAll?.();
                    }}
                  >
                    Delete all forever
                  </button>
                  <button
                    type="button"
                    className="wc-button wc-button--ghost"
                    onClick={() => setConfirmingAll(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="bin__actions">
                <span className="bin__count-label">
                  {backups.length} {backups.length === 1 ? 'deleted chat' : 'deleted chats'}
                </span>
                {onPurgeAll ? (
                  <button
                    type="button"
                    className="wc-button wc-button--ghost wc-button--danger bin__delete-all"
                    onClick={() => setConfirmingAll(true)}
                    title="Delete all backups forever"
                  >
                    <TrashIcon />
                    <span>Delete all</span>
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <ul className="bin__list">
          {backups.map((backup) => {
            // A backup outlives its character, and the server refuses to restore into one
            // that is gone. Nothing to show a picture of in that case, so the row drops the
            // avatar and says why rather than offering a click that can only fail.
            const character = byAvatar.get(backup.characterId);
            return (
              <li key={backup.backupId} className="bin__item">
                <button
                  type="button"
                  className="bin__restore"
                  onClick={() => onRestore(backup.backupId)}
                  disabled={!character}
                  title={
                    character
                      ? 'Restore this chat'
                      : `${backup.characterId} no longer exists — re-import the character, then restore.`
                  }
                >
                  {character ? (
                    <img
                      className="bin__avatar"
                      src={characterApi.imageUrl(backup.characterId)}
                      alt=""
                    />
                  ) : (
                    <span className="bin__avatar" aria-hidden="true" />
                  )}
                  <span className="bin__info">
                    <span className="bin__name">
                      {character?.name ?? backup.characterId.replace(/\.png$/i, '')}
                      <span className="bin__sep">–</span>
                      <span className="bin__title">{backup.title}</span>
                    </span>
                    <span className="bin__meta">
                      <span>deleted {deletedLabel(backup.deleted)}</span>
                      {backup.messageCount > 0 ? (
                        <span className="bin__count" title={`${backup.messageCount} messages`}>
                          <MessagesIcon />
                          {backup.messageCount}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="wc-button wc-button--ghost wc-button--danger"
                  data-confirming={purging === backup.backupId}
                  onClick={() =>
                    purging === backup.backupId
                      ? onPurge(backup.backupId)
                      : setPurging(backup.backupId)
                  }
                  onBlur={() => setPurging(null)}
                  title={
                    purging === backup.backupId
                      ? 'Click again to delete forever'
                      : 'Delete this backup forever'
                  }
                  aria-label={
                    purging === backup.backupId
                      ? 'Click again to delete forever'
                      : `Delete backup of ${backup.title} forever`
                  }
                >
                  <TrashIcon />
                </button>
              </li>
            );
          })}
        </ul></>
      )}
    </Section>
  );
}
