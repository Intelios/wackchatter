import type { CardSlot } from '@shared/types/cocreator.ts';
import { useCallback, useState } from 'react';
import { Menu } from '../../components/Menu.tsx';
import { ChevronIcon } from '../../layout/icons.tsx';
import { buildUseAsMenu } from './useAsMenu.ts';

interface UseAsMenuProps {
  /** The slot the block named, or null for prose, a whole message, or an unknown label. */
  slot: CardSlot | null;
  /** The text that would be filed. Resolved lazily for a selection, which changes as you drag. */
  getText: () => string;
  label: string;
  busy: boolean;
  isFilled: (slot: CardSlot) => boolean;
  requiresSelection?: boolean;
  onUse: (slot: CardSlot, text: string) => void;
}

/**
 * The one door content takes from the transcript into the card.
 *
 * A thin wrapper: the entries come from `buildUseAsMenu`, which is pure and tested. This
 * owns only the confirm-arming state, which has to disarm when the menu is dismissed rather
 * than confirmed — that is what `onOpenChange` exists for.
 */
export function UseAsMenu({
  slot,
  getText,
  label,
  busy,
  isFilled,
  requiresSelection,
  onUse,
}: UseAsMenuProps) {
  const [confirming, setConfirming] = useState<CardSlot | null>(null);
  const [text, setText] = useState('');

  // Resolved when the menu opens, not on every render: a selection is read from the
  // document, and reading it during render would make the component impure.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) setText(getText());
      else setConfirming(null);
    },
    [getText],
  );

  const entries = buildUseAsMenu(
    {
      slot,
      text,
      busy,
      filled: isFilled,
      confirming,
      ...(requiresSelection ? { requiresSelection } : {}),
    },
    {
      onUse: (target) => {
        setConfirming(null);
        onUse(target, text);
      },
      onArmConfirm: setConfirming,
    },
  );

  return (
    <Menu
      label={label}
      icon={
        <>
          <span>{label}</span>
          <ChevronIcon />
        </>
      }
      entries={entries}
      className="cocreator-use-as"
      // End-anchored: the trigger sits at the right edge of a block, and a start-anchored
      // popup would grow into the stash panel and be clipped by the transcript column.
      placement="bottom-end"
      onOpenChange={handleOpenChange}
    />
  );
}
