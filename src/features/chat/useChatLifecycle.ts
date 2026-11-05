/**
 * Moving between chats: open, new, reload, rename, delete, branch.
 *
 * Every move that leaves the open chat does the same three things first, in this order:
 * marks itself as a user action (so a late auto-open stands down), stops what is generating,
 * and flushes pending saves — refusing to move at all if the flush fails, since leaving
 * would strand the edits.
 */

import type { CardDataV2 } from '@shared/types/card.ts';
import { useCallback, useRef, useState } from 'react';
import { chatApi } from '../../lib/api.ts';
import type { ChatSession } from './useChatSession.ts';

export interface ChatLifecycleOptions {
  session: ChatSession;
  characterId: string | null;
  character: CardDataV2 | null;
  /** Stop the chat's generation. */
  abort: () => void;
  /** Stop the summary run. */
  cancelSummary: () => void;
}

export function useChatLifecycle(options: ChatLifecycleOptions) {
  const { session, characterId, character, abort, cancelSummary } = options;
  const { dispatch, stateRef, userChatAction, personaIdRef } = session;
  const { flushSaves, loadChat, refreshChats, setChats } = session;
  const [reloadCount, setReloadCount] = useState(0);

  /** Stop everything and flush; false when the flush failed and the move must not happen. */
  const leave = useCallback(
    async (stopGeneration = true) => {
      userChatAction.current += 1;
      if (stopGeneration) abort();
      cancelSummary();
      try {
        await flushSaves();
        return true;
      } catch {
        return false;
      }
    },
    [abort, cancelSummary, flushSaves, userChatAction],
  );

  const openChat = useCallback(
    async (chatId: string) => {
      if (!(await leave())) return;
      loadChat(await chatApi.get(chatId));
    },
    [leave, loadChat],
  );

  // Guards against overlapping `/reload`s — each fetch is pointless once a newer one has
  // replaced the transcript it would have applied over.
  const reloading = useRef(false);

  const reloadChat = useCallback(async () => {
    const current = stateRef.current;
    if (!current.chatId || current.status !== 'idle' || reloading.current) return;
    reloading.current = true;
    try {
      // Flush first so the fetch reflects our edits and none are lost.
      await flushSaves();
      const revisionBefore = stateRef.current.revision;
      const chat = await chatApi.get(current.chatId);
      // Only apply if the transcript is still the one we started from. Anything the user did
      // while the request was in flight is newer than the fetched copy, so applying it would
      // silently discard that work — keep the local state instead.
      if (stateRef.current.chatId !== current.chatId) return;
      if (stateRef.current.revision !== revisionBefore) return;
      loadChat(chat);
      setReloadCount((count) => count + 1);
    } finally {
      reloading.current = false;
    }
  }, [flushSaves, loadChat, stateRef]);

  const newChat = useCallback(async () => {
    if (!characterId || !character) return;
    if (!(await leave())) return;
    const chat = await chatApi.create({
      characterId,
      title: 'New chat',
      metadata: { persona: personaIdRef.current },
    });
    loadChat(chat);
    dispatch({ type: 'chat/greeting', id: crypto.randomUUID(), card: character });
    await refreshChats();
  }, [characterId, character, leave, loadChat, dispatch, refreshChats, personaIdRef]);

  const renameChat = useCallback(
    (title: string) => {
      dispatch({ type: 'chat/renamed', title });
      const chatId = stateRef.current.chatId;
      if (chatId) {
        // The list only re-fetches on structural changes, so reflect the rename at once.
        setChats((list) => list.map((chat) => (chat.id === chatId ? { ...chat, title } : chat)));
      }
    },
    [dispatch, stateRef, setChats],
  );

  const deleteChat = useCallback(
    async (chatId: string) => {
      // Deleting another chat leaves the open one generating.
      if (!(await leave(stateRef.current.chatId === chatId))) return;
      await chatApi.remove(chatId);
      if (stateRef.current.chatId === chatId) dispatch({ type: 'chat/closed' });
      await refreshChats();
    },
    [leave, dispatch, refreshChats, stateRef],
  );

  const branchFrom = useCallback(
    async (messageId: string) => {
      if (!stateRef.current.chatId) return;
      if (!(await leave())) return;
      const branch = await chatApi.branch(stateRef.current.chatId, messageId);
      loadChat(branch);
      await refreshChats();
    },
    [leave, loadChat, refreshChats, stateRef],
  );

  return { openChat, reloadChat, reloadCount, newChat, renameChat, deleteChat, branchFrom };
}
