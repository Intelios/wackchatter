/**
 * The group scene's burger — the group's counterpart to `ChatMenu`.
 *
 * It owns only the form: the rename popover's open state and the two-click delete's arm
 * state, both held outside the entry list so a dismissal disarms them. The entries come
 * from `buildGroupMenu`, pure and pinned by tests.
 */

import { useRef, useState } from 'react';
import { Menu } from '../../components/Menu.tsx';
import { MenuIcon } from '../../layout/icons.tsx';
import { chatApi } from '../../lib/api.ts';
import { downloadUrl } from '../../lib/download.ts';
import { RenameChatPopover } from '../chat/RenameChatPopover.tsx';
import { buildGroupMenu, type GroupMenuActions, type GroupMenuState } from './groupMenu.tsx';
import type { GroupChatController } from './useGroupChat.ts';

interface GroupChatMenuProps {
  chat: GroupChatController;
  directorConfigured: boolean;
  /** Ends the exchange: the composer's Stop and the menu's "Stop all" are the same act. */
  onStopAll: () => void;
  onPause: () => void;
  onContinue: () => void;
  onOpenCast: () => void;
  onOpenMemory: () => void;
  onOpenInspect: () => void;
  onOpenBranchTree: () => void;
  /** Leave the scene for the Start screen. */
  onCloseScene: () => void;
  onDeleteScene: () => void;
  onSelectMember: (id: string) => void;
}

export function GroupChatMenu({
  chat,
  directorConfigured,
  onStopAll,
  onPause,
  onContinue,
  onOpenCast,
  onOpenMemory,
  onOpenInspect,
  onOpenBranchTree,
  onCloseScene,
  onDeleteScene,
  onSelectMember,
}: GroupChatMenuProps) {
  const scene = chat.state.metadata.group;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const state: GroupMenuState = {
    conversationActive: Boolean(chat.coordinator?.running || chat.coordinator?.selecting),
    generating:
      chat.state.status !== 'idle' ||
      Boolean(chat.coordinator?.running || chat.coordinator?.selecting) ||
      (chat.coordinator?.jobs.size ?? 0) > 0,
    summaryRunning: chat.summaryStatus.running,
    memoryRunning: chat.nexus.run.running,
    directorConfigured,
    messageCount: chat.state.messages.length,
    chatId: chat.state.chatId,
    members: scene?.members ?? [],
    selectedMemberId: chat.selectedMemberId,
    confirmingDelete: confirmDelete,
  };

  const actions: GroupMenuActions = {
    continueConversation: onContinue,
    pauseConversation: onPause,
    stopAll: onStopAll,
    renameScene: () => setRenameOpen(true),
    openCast: onOpenCast,
    openMemory: onOpenMemory,
    openInspect: onOpenInspect,
    openBranchTree: onOpenBranchTree,
    exportScene: () => {
      const id = chat.state.chatId;
      if (id) downloadUrl(chatApi.exportUrl(id));
    },
    selectMember: onSelectMember,
    deleteScene: () => (confirmDelete ? onDeleteScene() : setConfirmDelete(true)),
    closeScene: onCloseScene,
  };

  return (
    <>
      <Menu
        label="Scene menu"
        icon={<MenuIcon />}
        placement="top-start"
        triggerRef={menuTriggerRef}
        entries={buildGroupMenu(state, actions)}
        // The delete confirm is armed in here, so the menu's own close is the hook that
        // must disarm it — a dismissal without confirming must not leave the next open
        // one click away from deleting the scene.
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(false);
        }}
      />
      <RenameChatPopover
        open={renameOpen}
        onOpenChange={setRenameOpen}
        triggerRef={menuTriggerRef}
        title={chat.state.title}
        onRename={(title) => chat.dispatch({ type: 'chat/renamed', title })}
      />
    </>
  );
}
