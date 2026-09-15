/**
 * The group scene's burger menu — where every scene-level action lives.
 *
 * A group chat used to carry its own four-band chrome (a title header, a toolbar of six
 * buttons, a status strip and a controls bar) above and below the transcript. That is the
 * whole reason it read as a different app; a one-on-one chat has none of it, and puts its
 * equivalents behind the composer's burger. So the scene actions moved here, and the menu
 * is the group's only home for them.
 *
 * Entries are built by a pure function so the gating is testable without a DOM, following
 * `buildChatMenu`.
 */

import { type GroupMember, memberLabel } from '@shared/types/group.ts';
import type { MenuEntry } from '../../components/Menu.tsx';
import {
  BranchIcon,
  CloseIcon,
  ContinueIcon,
  DownloadIcon,
  EditIcon,
  NotesIcon,
  PauseIcon,
  StopIcon,
  SummaryIcon,
  TrashIcon,
  UsersIcon,
  WandIcon,
} from '../../layout/icons.tsx';

export interface GroupMenuState {
  /** The transcript's coordinator is running or asking the director who speaks. */
  conversationActive: boolean;
  /** Any member generation in flight — the director's or a member's. */
  generating: boolean;
  /** A blocking classic summary prevents provider work but not reading. */
  summaryRunning?: boolean;
  /** A blocking memory extraction prevents provider work but not reading. */
  memoryRunning?: boolean;
  /** The automatic exchange needs a director connection and model. */
  directorConfigured: boolean;
  messageCount: number;
  chatId: string | null;
  members: readonly GroupMember[];
  /** The member `{{char}}` resolves to for the next thing you write. */
  selectedMemberId: string;
  /** Set once the delete entry has been chosen once, per the two-click confirm rule. */
  confirmingDelete: boolean;
}

export interface GroupMenuActions {
  /** Run an exchange: the director picks who speaks, up to the reply limit. */
  continueConversation: () => void;
  /** Stop scheduling further replies; the ones already running finish. */
  pauseConversation: () => void;
  /** Abort every generation. */
  stopAll: () => void;
  renameScene: () => void;
  openCast: () => void;
  openMemory: () => void;
  openInspect: () => void;
  openBranchTree: () => void;
  exportScene: () => void;
  /** Point `{{char}}` at a member without starting a generation. */
  selectMember: (id: string) => void;
  deleteScene: () => void;
  /** Leave the scene for the Start screen. */
  closeScene: () => void;
  customiseComposer?: () => void;
  guideReply?: () => void;
}

const GENERATING = 'Wait for the current replies to finish.';
const SUMMARY_BUSY = 'Cancel or finish the current summary first.';
const MEMORY_BUSY = 'Cancel or finish the current memory extraction first.';
const NO_DIRECTOR = 'Choose a director connection and model in Cast & settings first.';

export function buildGroupMenu(state: GroupMenuState, actions: GroupMenuActions): MenuEntry[] {
  const {
    conversationActive,
    generating,
    summaryRunning = false,
    memoryRunning = false,
    directorConfigured,
    messageCount,
    chatId,
    members,
    selectedMemberId,
    confirmingDelete,
  } = state;
  const providerBlocked = generating || summaryRunning || memoryRunning;
  const providerBlockedReason = summaryRunning
    ? SUMMARY_BUSY
    : memoryRunning
      ? MEMORY_BUSY
      : GENERATING;
  // Pausing abort nothing, so it answers to the conversation alone — a member's reply
  // arriving is exactly when you might decide this exchange has said enough.
  const continueDisabled = !directorConfigured || providerBlocked;

  return [
    {
      label: messageCount ? 'Continue conversation' : 'Start scene',
      icon: <ContinueIcon />,
      // Silent about the director until one is configured, but not silently useless: the
      // reason rides on the entry, and the tray's own button carries the same one.
      disabled: continueDisabled,
      disabledReason: !directorConfigured
        ? NO_DIRECTOR
        : providerBlocked
          ? providerBlockedReason
          : undefined,
      onSelect: actions.continueConversation,
    },
    {
      // Always available: a paused conversation has a job in flight that this must be able
      // to stop, and an empty one needs neither button to be disabled to be understood.
      label: 'Pause conversation',
      icon: <PauseIcon />,
      disabled: !conversationActive,
      disabledReason: 'The conversation is not running.',
      onSelect: actions.pauseConversation,
    },
    {
      label: 'Stop all',
      icon: <StopIcon />,
      disabled: !conversationActive && !generating,
      disabledReason: 'Nothing is running.',
      onSelect: actions.stopAll,
    },

    { kind: 'separator' },

    {
      label: 'Cast & settings…',
      icon: <UsersIcon />,
      onSelect: actions.openCast,
    },
    {
      label: 'Memory…',
      icon: <SummaryIcon />,
      onSelect: actions.openMemory,
    },
    {
      // Reads, so like the 1:1 card reader it is deliberately not gated on the reply —
      // "what is actually being sent" is a question you ask while one is arriving.
      label: 'Inspect prompt…',
      icon: <NotesIcon />,
      onSelect: actions.openInspect,
    },
    {
      label: 'Branch timeline…',
      icon: <BranchIcon />,
      disabled: !chatId,
      disabledReason: 'No scene is open.',
      onSelect: actions.openBranchTree,
    },
    {
      label: 'Rename scene…',
      icon: <EditIcon />,
      disabled: generating,
      disabledReason: GENERATING,
      onSelect: actions.renameScene,
    },
    {
      label: 'Export scene',
      icon: <DownloadIcon />,
      // The in-flight replies are not persisted yet; an export would miss them.
      disabled: generating,
      disabledReason: GENERATING,
      onSelect: actions.exportScene,
    },
    {
      label: 'Customise composer…',
      icon: <EditIcon />,
      disabled: generating,
      disabledReason: GENERATING,
      onSelect: actions.customiseComposer ?? (() => {}),
    },
    {
      label: 'Guide next reply',
      icon: <WandIcon />,
      disabled: providerBlocked,
      disabledReason: providerBlocked ? providerBlockedReason : undefined,
      onSelect: actions.guideReply ?? (() => {}),
    },

    { kind: 'separator' },

    {
      /*
       * `{{char}}` in a group is ambiguous, so it is a pick rather than a guess. This is
       * the no-generation door onto the same selection the tray's "Speak next" chip sets
       * when it calls on a member — the tray makes someone reply, this only says who
       * "you" are addressing.
       */
      kind: 'submenu',
      label: 'Macro character',
      icon: <UsersIcon />,
      hint: members.find((m) => m.id === selectedMemberId)?.name,
      entries: members.map((member) => ({
        label: memberLabel(member, members),
        hint: member.id === selectedMemberId ? 'current' : undefined,
        onSelect: () => actions.selectMember(member.id),
      })),
    },

    { kind: 'separator' },

    {
      // Two-click confirm in place, not a dialog, and `keepOpen` is what makes the first
      // click arm it rather than dismissing the menu before you can confirm.
      label: confirmingDelete ? 'Click again to delete' : 'Delete scene',
      icon: <TrashIcon />,
      danger: true,
      disabled: generating,
      disabledReason: generating ? GENERATING : undefined,
      keepOpen: !confirmingDelete,
      onSelect: actions.deleteScene,
    },
    {
      label: 'Close scene',
      icon: <CloseIcon />,
      disabled: generating,
      disabledReason: GENERATING,
      onSelect: actions.closeScene,
    },
  ];
}
