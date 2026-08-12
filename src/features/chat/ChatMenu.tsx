/**
 * The chat options menu — SillyTavern's burger, reduced to the tools this app has.
 *
 * The entry list is built by `buildChatMenu`, a pure function, so the gating rules ("you
 * cannot continue a transcript that ends on your own turn") are testable without a DOM.
 * There is no DOM test infrastructure in this project; extracting the logic is how
 * `useLorebooks` handles the same problem.
 */

import type { QuickCommand } from '@shared/types/settings.ts';
import { useRef, useState } from 'react';
import type { MenuEntry, MenuSubmenu } from '../../components/Menu.tsx';
import { Menu } from '../../components/Menu.tsx';
import {
  BoltIcon,
  BookIcon,
  BranchIcon,
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
import { QuickCommandsPopover } from './QuickCommandsPopover.tsx';
import { commandHint, commandLabel, usableCommands } from './quickCommands.ts';
import type { UseChat } from './useChat.ts';

export interface ChatMenuState {
  /** A generation is in flight. */
  busy: boolean;
  /** A blocking summary request prevents only provider-generating actions. */
  summaryRunning?: boolean;
  messageCount: number;
  lastMessageId: string | null;
  /** The transcript ends on the user's turn, so there is nothing to continue. */
  lastIsUser: boolean;
  /** User-defined snippets inserted into the composer. Blank ones never arrive. */
  quickCommands: QuickCommand[];
}

export interface ChatMenuActions {
  newChat: () => void;
  checkpoint: (messageId: string) => void;
  regenerate: () => void;
  continueLast: () => void;
  openPanel: (panel: RightPanelId) => void;
  closeChat: () => void;
  exportChat: () => void;
  importChat: () => void;
  insertCommand: (text: string) => void;
  editQuickCommands: () => void;
}

interface QuickCommandsActions {
  insertCommand: (text: string) => void;
  editQuickCommands: () => void;
}

const BUSY = 'Wait for the current reply to finish.';
const SUMMARY_BUSY = 'Cancel or finish the current summary first.';
const EMPTY = 'This chat has no messages yet.';

export function buildChatMenu(state: ChatMenuState, actions: ChatMenuActions): MenuEntry[] {
  const {
    busy,
    summaryRunning = false,
    messageCount,
    lastMessageId,
    lastIsUser,
    quickCommands,
  } = state;
  const empty = messageCount === 0;
  const generationBlocked = busy || summaryRunning;
  const generationBlockedReason = summaryRunning ? SUMMARY_BUSY : BUSY;

  return [
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

    buildQuickCommandsSubmenu(quickCommands, actions),

    { kind: 'separator' },

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

/**
 * The quick-commands flyout. Deliberately NOT gated on `busy`: picking a command only
 * fills the composer, and the composer accepts text mid-generation — queueing your next
 * move is the point. With no commands defined the edit entry alone remains — that is the
 * discovery path for the feature.
 */
export function buildQuickCommandsSubmenu(
  quickCommands: QuickCommand[],
  actions: QuickCommandsActions,
): MenuSubmenu {
  const usable = usableCommands(quickCommands);

  const commandEntries: MenuEntry[] = usable.map((command) => ({
    key: command.id,
    label: commandLabel(command),
    icon: <BoltIcon />,
    // The hint repeats the label on unnamed commands, so it only joins a real name.
    hint: command.name.trim() ? commandHint(command) : undefined,
    onSelect: () => actions.insertCommand(command.text),
  }));

  return {
    kind: 'submenu',
    label: 'Quick commands',
    icon: <BoltIcon />,
    hint: usable.length > 0 ? String(usable.length) : undefined,
    entries: [
      ...commandEntries,
      ...(commandEntries.length > 0 ? [{ kind: 'separator' as const }] : []),
      {
        label: 'Edit quick commands…',
        icon: <EditIcon />,
        onSelect: actions.editQuickCommands,
      },
    ],
  };
}

interface ChatMenuProps {
  chat: UseChat;
  onCloseChat: () => void;
  onOpenPanel: (panel: RightPanelId) => void;
  quickCommands: QuickCommand[];
  /** Places a command's text in the composer, ready to send. */
  onInsertCommand: (text: string) => void;
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
  /** Reads a chat export into the open character as a new chat. */
  onImportChat: (file: File) => void;
}

export function ChatMenu({
  chat,
  onCloseChat,
  onOpenPanel,
  quickCommands,
  onInsertCommand,
  onQuickCommandsChange,
  onImportChat,
}: ChatMenuProps) {
  const { messages } = chat.state;
  const last = messages[messages.length - 1] ?? null;

  // The editor opens from inside the menu but grows out of the burger button itself, so
  // both popups share that anchor.
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  const entries = buildChatMenu(
    {
      busy: chat.busy,
      summaryRunning: chat.summaryStatus.running,
      messageCount: messages.length,
      lastMessageId: last?.id ?? null,
      lastIsUser: Boolean(last?.is_user),
      quickCommands,
    },
    {
      newChat: () => void chat.newChat(),
      checkpoint: (id) => void chat.branchFrom(id),
      regenerate: () => void chat.regenerate(),
      continueLast: () => void chat.continueLast(),
      openPanel: onOpenPanel,
      closeChat: onCloseChat,
      insertCommand: onInsertCommand,
      editQuickCommands: () => setEditorOpen(true),
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
      <QuickCommandsPopover
        commands={quickCommands}
        onCommandsChange={onQuickCommandsChange}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        triggerRef={menuTriggerRef}
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
