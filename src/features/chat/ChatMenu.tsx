/**
 * The chat options menu — SillyTavern's burger, reduced to the tools this app has.
 *
 * The entry list is built by `buildChatMenu`, a pure function, so the gating rules ("you
 * cannot continue a transcript that ends on your own turn") are testable without a DOM.
 * There is no DOM test infrastructure in this project; extracting the logic is how
 * `useLorebooks` handles the same problem.
 */

import type { MenuEntry } from '../../components/Menu.tsx';
import { Menu } from '../../components/Menu.tsx';
import {
  BranchIcon,
  CloseIcon,
  ContinueIcon,
  MenuIcon,
  MessagesIcon,
  PlusIcon,
  RefreshIcon,
  SlidersIcon,
  UsersIcon,
} from '../../layout/icons.tsx';
import type { UseChat } from './useChat.ts';

/** The right panel's tabs, as far as this menu needs to know about them. */
export type PanelTab = 'characters' | 'lore' | 'you';

export interface ChatMenuState {
  /** A generation is in flight. */
  busy: boolean;
  messageCount: number;
  lastMessageId: string | null;
  /** The transcript ends on the user's turn, so there is nothing to continue. */
  lastIsUser: boolean;
}

export interface ChatMenuActions {
  newChat: () => void;
  checkpoint: (messageId: string) => void;
  regenerate: () => void;
  continueLast: () => void;
  openPanel: (tab: PanelTab) => void;
  closeChat: () => void;
}

const BUSY = 'Wait for the current reply to finish.';
const EMPTY = 'This chat has no messages yet.';

export function buildChatMenu(state: ChatMenuState, actions: ChatMenuActions): MenuEntry[] {
  const { busy, messageCount, lastMessageId, lastIsUser } = state;
  const empty = messageCount === 0;

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
      disabled: busy || empty,
      disabledReason: busy ? BUSY : EMPTY,
      onSelect: actions.regenerate,
    },
    {
      label: 'Continue',
      icon: <ContinueIcon />,
      disabled: busy || empty || lastIsUser,
      disabledReason: busy ? BUSY : empty ? EMPTY : 'The last message is yours.',
      onSelect: actions.continueLast,
    },

    { kind: 'separator' },

    // Jumps, not actions — these open the panel where the tool already lives, rather than
    // growing a second copy of it in here.
    {
      label: 'Chat context…',
      icon: <MessagesIcon />,
      onSelect: () => actions.openPanel('characters'),
    },
    { label: 'Lore…', icon: <SlidersIcon />, onSelect: () => actions.openPanel('lore') },
    { label: 'Persona…', icon: <UsersIcon />, onSelect: () => actions.openPanel('you') },

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
  onOpenPanel: (tab: PanelTab) => void;
}

export function ChatMenu({ chat, onCloseChat, onOpenPanel }: ChatMenuProps) {
  const { messages } = chat.state;
  const last = messages[messages.length - 1] ?? null;

  const entries = buildChatMenu(
    {
      busy: chat.busy,
      messageCount: messages.length,
      lastMessageId: last?.id ?? null,
      lastIsUser: Boolean(last?.is_user),
    },
    {
      newChat: () => void chat.newChat(),
      checkpoint: (id) => void chat.branchFrom(id),
      regenerate: () => void chat.regenerate(),
      continueLast: () => void chat.continueLast(),
      openPanel: onOpenPanel,
      closeChat: onCloseChat,
    },
  );

  return <Menu label="Chat options" icon={<MenuIcon />} entries={entries} />;
}
