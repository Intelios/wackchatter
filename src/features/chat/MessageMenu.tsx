/**
 * A message's secondary actions.
 *
 * Edit and the swipe controls stay on the bubble because they are the two things you
 * reach for constantly; everything else lives behind the ⋯ so a long transcript stays
 * quiet. The entries are built by a pure function so the gating ("you cannot regenerate a
 * message that is not the last one") is testable without a DOM, following `buildChatMenu`.
 */

import type { MenuEntry } from '../../components/Menu.tsx';
import { Menu } from '../../components/Menu.tsx';
import {
  BranchIcon,
  ContinueIcon,
  EyeIcon,
  EyeOffIcon,
  MoreIcon,
  RefreshIcon,
  TrashIcon,
} from '../../layout/icons.tsx';

export interface MessageMenuState {
  /** A generation is in flight. */
  busy: boolean;
  /** Summary generation blocks reply generation but not transcript structure. */
  summaryRunning?: boolean;
  /** Swiping, regenerating and continuing all act on a reply at the end of the transcript. */
  isLast: boolean;
  isUser: boolean;
  /** Hidden from the prompt, but still in the transcript. */
  isHidden: boolean;
  /** Set once the delete entry has been chosen once, per the two-click confirm rule. */
  confirmingDelete: boolean;
}

export interface MessageMenuActions {
  regenerate: () => void;
  continueLast: () => void;
  toggleHidden: () => void;
  branch: () => void;
  delete: () => void;
}

const BUSY = 'Wait for the current reply to finish.';
const SUMMARY_BUSY = 'Cancel or finish the current summary first.';
const NOT_LAST = 'Only the last reply can be regenerated.';

export function buildMessageMenu(
  state: MessageMenuState,
  actions: MessageMenuActions,
): MenuEntry[] {
  const { busy, summaryRunning = false, isLast, isUser, isHidden, confirmingDelete } = state;
  // A user turn at the end is owed a reply, not a regeneration — the bubble offers Retry
  // for that case instead.
  const canReply = isLast && !isUser;
  const generationBlocked = busy || summaryRunning;
  const generationBlockedReason = summaryRunning ? SUMMARY_BUSY : BUSY;

  return [
    {
      label: 'Regenerate',
      icon: <RefreshIcon />,
      disabled: generationBlocked || !canReply,
      disabledReason: generationBlocked ? generationBlockedReason : NOT_LAST,
      onSelect: actions.regenerate,
    },
    {
      label: 'Continue',
      icon: <ContinueIcon />,
      disabled: generationBlocked || !canReply,
      disabledReason: generationBlocked ? generationBlockedReason : NOT_LAST,
      onSelect: actions.continueLast,
    },

    { kind: 'separator' },

    {
      label: isHidden ? 'Show to the model' : 'Hide from the prompt',
      icon: isHidden ? <EyeOffIcon /> : <EyeIcon />,
      hint: isHidden ? undefined : 'stays in the transcript',
      onSelect: actions.toggleHidden,
    },
    {
      label: 'Branch from here',
      icon: <BranchIcon />,
      disabled: busy,
      disabledReason: BUSY,
      onSelect: actions.branch,
    },

    { kind: 'separator' },

    {
      // Two-click confirm in place, not a dialog. `keepOpen` is what makes the first click
      // arm it rather than dismissing the menu before you can confirm.
      label: confirmingDelete ? 'Click again to delete' : 'Delete',
      icon: <TrashIcon />,
      danger: true,
      keepOpen: !confirmingDelete,
      onSelect: actions.delete,
    },
  ];
}

interface MessageMenuProps {
  state: MessageMenuState;
  actions: MessageMenuActions;
}

export function MessageMenu({ state, actions }: MessageMenuProps) {
  return (
    <Menu
      label="More actions"
      icon={<MoreIcon />}
      placement="bottom-end"
      className="message__menu"
      entries={buildMessageMenu(state, actions)}
    />
  );
}
