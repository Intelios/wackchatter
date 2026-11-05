/**
 * The trash bin, across every character — it is shown in User Settings, which is not a
 * per-character place — and the chat moves that fill or empty it: delete, restore, purge,
 * import. Every one touches the bin, so it is refetched after each rather than kept in sync
 * by hand.
 */

import type { ChatBackupSummary } from '@shared/types/chat.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseChat } from '../features/chat/useChat.ts';
import { backupApi, chatApi } from '../lib/api.ts';

export function useBackups(options: {
  chat: Pick<UseChat, 'deleteChat' | 'refreshChats' | 'openChat'>;
  /** The open character, if any. */
  selected: string | null;
  /** Open a chat on another character, through the same door the recent-chat rows use. */
  openOnCharacter: (characterId: string, chatId: string) => void;
  onError: (message: string) => void;
}) {
  const { chat, selected, openOnCharacter } = options;
  const [backups, setBackups] = useState<ChatBackupSummary[]>([]);
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await backupApi.list());
    } catch {
      // Keep the last good list; a stale bin is better than a blank one.
    }
  }, []);

  useEffect(() => {
    void refreshBackups();
  }, [refreshBackups]);

  /** Run a bin-changing action, report its failure, and refetch the bin either way. */
  const touching = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (err) {
        onErrorRef.current((err as Error).message);
      } finally {
        void refreshBackups();
      }
    },
    [refreshBackups],
  );

  const deleteChat = useCallback(
    (id: string) => touching(() => chat.deleteChat(id)),
    [chat, touching],
  );

  /**
   * Bring a deleted chat back and open it.
   *
   * The bin is reachable from the start screen, where the restored chat's character is
   * usually not the open one — and may be no character at all. Restoring across that boundary
   * goes through the same door the recent-chat rows use, so the character is selected and its
   * panels reset exactly as if the chat had been opened normally.
   */
  const restoreBackup = useCallback(
    (backupId: string) =>
      touching(async () => {
        const restored = await backupApi.restore(backupId);
        if (selected === restored.characterId) {
          await chat.refreshChats();
          void chat.openChat(restored.id);
        } else {
          openOnCharacter(restored.characterId, restored.id);
        }
      }),
    [chat, selected, openOnCharacter, touching],
  );

  /** Empty one slot of the bin for good. */
  const purgeBackup = useCallback(
    (backupId: string) => touching(() => backupApi.remove(backupId)),
    [touching],
  );

  /** Empty every slot of the bin for good. */
  const purgeAllBackups = useCallback(() => touching(() => backupApi.removeAll()), [touching]);

  const importChat = useCallback(
    async (file: File) => {
      if (!selected) return;
      try {
        const imported = await chatApi.import(file, selected);
        await chat.refreshChats();
        void chat.openChat(imported.id);
      } catch (err) {
        onErrorRef.current((err as Error).message);
      }
    },
    [selected, chat],
  );

  return { backups, deleteChat, restoreBackup, purgeBackup, purgeAllBackups, importChat };
}
