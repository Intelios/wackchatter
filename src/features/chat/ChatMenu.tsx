/**
 * The chat options menu — SillyTavern's burger, reduced to the tools this app has.
 *
 * The entry list is built by `buildChatMenu`, a pure function, so the gating rules ("you
 * cannot continue a transcript that ends on your own turn") are testable without a DOM.
 * There is no DOM test infrastructure in this project; extracting the logic is how
 * `useLorebooks` handles the same problem.
 */

import { useRef, useState } from 'react';
import type { MenuEntry } from '../../components/Menu.tsx';
import { Menu } from '../../components/Menu.tsx';
import {
  BookIcon,
  BranchIcon,
  CardIcon,
  CloseIcon,
  ContinueIcon,
  DownloadIcon,
  EditIcon,
  MenuIcon,
  MessagesIcon,
  PlusIcon,
  RefreshIcon,
  UploadIcon,
  UserIcon,
} from '../../layout/icons.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { chatApi } from '../../lib/api.ts';
import { downloadUrl } from '../../lib/download.ts';
import { RenameChatPopover } from './RenameChatPopover.tsx';
import type { UseChat } from './useChat.ts';

export interface ChatMenuState {
  /** A generation is in flight. */
  busy: boolean;
  /** A blocking summary request prevents only provider-generating actions. */
  summaryRunning?: boolean;
  /** A blocking memory extraction prevents only provider-generating actions. */
  memoryRunning?: boolean;
  /** The open chat — the branch timeline has nothing to centre on without one. */
  chatId: string | null;
  messageCount: number;
  lastMessageId: string | null;
  /** The transcript ends on the user's turn, so there is nothing to continue. */
  lastIsUser: boolean;
}

export interface ChatMenuActions {
  newChat: () => void;
  openNexus?: () => void;
  checkpoint: (messageId: string) => void;
  regenerate: () => void;
  continueLast: () => void;
  /** Opens the rename popover anchored to the burger. */
  renameChat: () => void;
  openPanel: (panel: RightPanelId) => void;
  closeChat: () => void;
  exportChat: () => void;
  importChat: () => void;
  openCard: () => void;
  openBranchTree: () => void;
}

const BUSY = 'Wait for the current reply to finish.';
const SUMMARY_BUSY = 'Cancel or finish the current summary first.';
const MEMORY_BUSY = 'Cancel or finish the current memory extraction first.';
const EMPTY = 'This chat has no messages yet.';

export function buildChatMenu(state: ChatMenuState, actions: ChatMenuActions): MenuEntry[] {
  const {
    busy,
    summaryRunning = false,
    memoryRunning = false,
    chatId,
    messageCount,
    lastMessageId,
    lastIsUser,
  } = state;
  const empty = messageCount === 0;
  const generationBlocked = busy || summaryRunning || memoryRunning;
  const generationBlockedReason = summaryRunning
    ? SUMMARY_BUSY
    : memoryRunning
      ? MEMORY_BUSY
      : BUSY;

  return [
    ...(actions.openNexus
      ? [{ label: 'Memory Nexus', onSelect: actions.openNexus, disabled: !chatId }]
      : []),
    {
      label: 'New chat',
      icon: <PlusIcon />,
      disabled: busy,
      disabledReason: BUSY,
      onSelect: actions.newChat,
    },
    {
      label: 'Save checkpoint',
      icon: <BranchIcon />,
      disabled: busy || empty || !lastMessageId,
      disabledReason: busy ? BUSY : EMPTY,
      // Guarded above, but a checkpoint of nothing is worse than a no-op.
      onSelect: () => lastMessageId && actions.checkpoint(lastMessageId),
    },

    { kind: 'separator' },

    {
      label: 'Regenerate',
      icon: <RefreshIcon />,
      disabled: generationBlocked || empty,
      disabledReason: generationBlocked ? generationBlockedReason : EMPTY,
      onSelect: actions.regenerate,
    },
    {
      label: 'Continue',
      icon: <ContinueIcon />,
      disabled: generationBlocked || empty || lastIsUser,
      disabledReason: generationBlocked
        ? generationBlockedReason
        : empty
          ? EMPTY
          : 'The last message is yours.',
      onSelect: actions.continueLast,
    },
    {
      // A rename is a real mutation — a revision bump and a save — so it waits for the
      // reply with its neighbours here; `/rename` from the composer is already blocked in
      // that window, and this is the same rule through a second door.
      label: 'Rename chat…',
      icon: <EditIcon />,
      disabled: busy || !chatId,
      disabledReason: busy ? BUSY : 'No chat is open.',
      onSelect: actions.renameChat,
    },
    {
      label: 'Export chat',
      icon: <DownloadIcon />,
      // The in-flight reply is not in the database yet; an export would miss it.
      disabled: busy,
      disabledReason: BUSY,
      onSelect: actions.exportChat,
    },
    {
      // Import came out of the character panel with the chat list. It belongs beside
      // Export rather than in a panel: both are the same operation on this character's
      // chats, pointed in opposite directions.
      label: 'Import chat',
      icon: <UploadIcon />,
      disabled: busy,
      disabledReason: BUSY,
      onSelect: actions.importChat,
    },

    { kind: 'separator' },

    /*
     * Deliberately not gated on `busy`, unlike everything above it.
     *
     * Its neighbours mutate the chat, so blocking them mid-reply is right. This one only
     * reads, and "what colour is her hair" is a question you ask *while* a reply is
     * arriving — the composer suppresses `/card` in that window, so this entry is the
     * mid-generation way in. Do not "restore consistency" by disabling it.
     */
    {
      label: 'Character card…',
      icon: <CardIcon />,
      onSelect: actions.openCard,
    },

    /*
     * The timeline reads too, so it keeps the card's mid-generation availability — the
     * moment a fork looks wrong is exactly when you want to see where you are. The jumps
     * inside it are the part that waits for the reply.
     */
    {
      label: 'Branch timeline…',
      icon: <BranchIcon />,
      disabled: !chatId,
      disabledReason: 'No chat is open.',
      onSelect: actions.openBranchTree,
    },

    // Jumps, not actions — these open the panel where the tool already lives, rather than
    // growing a second copy of it in here.
    {
      label: 'Chat context…',
      icon: <MessagesIcon />,
      onSelect: () => actions.openPanel('characters'),
    },
    { label: 'Lore…', icon: <BookIcon />, onSelect: () => actions.openPanel('lorebooks') },
    { label: 'Persona…', icon: <UserIcon />, onSelect: () => actions.openPanel('persona') },

    { kind: 'separator' },

    {
      label: 'Close chat',
      icon: <CloseIcon />,
      disabled: busy,
      disabledReason: BUSY,
      onSelect: actions.closeChat,
    },
  ];
}

interface ChatMenuProps {
  chat: UseChat;
  onCloseChat: () => void;
  onOpenPanel: (panel: RightPanelId) => void;
  /** Reads a chat export into the open character as a new chat. */
  onImportChat: (file: File) => void;
  /** Opens the card reader — the one entry here that works mid-generation. */
  onOpenCard: () => void;
  /** Opens the branch timeline — reads only, like the card reader. */
  onOpenBranchTree: () => void;
}

export function ChatMenu({
  chat,
  onCloseChat,
  onOpenPanel,
  onImportChat,
  onOpenCard,
  onOpenBranchTree,
}: ChatMenuProps) {
  const { messages } = chat.state;
  const last = messages[messages.length - 1] ?? null;

  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const entries = buildChatMenu(
    {
      busy: chat.busy,
      summaryRunning: chat.summaryStatus.running,
      memoryRunning: chat.memoryStatus.running,
      chatId: chat.state.chatId,
      messageCount: messages.length,
      lastMessageId: last?.id ?? null,
      lastIsUser: Boolean(last?.is_user),
    },
    {
      newChat: () => void chat.newChat(),
      checkpoint: (id) => void chat.branchFrom(id),
      regenerate: () => void chat.regenerate(),
      continueLast: () => void chat.continueLast(),
      renameChat: () => setRenameOpen(true),
      openPanel: onOpenPanel,
      closeChat: onCloseChat,
      openCard: onOpenCard,
      openBranchTree: onOpenBranchTree,
      openNexus: () => chat.nexus.show(),
      importChat: () => importInput.current?.click(),
      exportChat: () => {
        const chatId = chat.state.chatId;
        if (!chatId) return;
        downloadUrl(chatApi.exportUrl(chatId));
      },
    },
  );

  return (
    <div className="chat-menu">
      <Menu
        label="Chat options"
        icon={<MenuIcon />}
        entries={entries}
        triggerRef={menuTriggerRef}
      />
      <RenameChatPopover
        open={renameOpen}
        onOpenChange={setRenameOpen}
        triggerRef={menuTriggerRef}
        title={chat.state.title}
        onRename={chat.renameChat}
      />
      <input
        ref={importInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onImportChat(file);
          // Allow re-selecting the same file: the value is not cleared by selection.
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
}
