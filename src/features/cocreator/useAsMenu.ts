/**
 * The "Use as ▾" menu — the one door content takes from the transcript into the card.
 *
 * Pure and tested for the same reason `buildMessageMenu` and `buildChatMenu` are: menu
 * entries here are data, not JSX, so the rules that matter (what is offered, what is blocked
 * and why, what arms a confirm instead of firing) are assertable without a DOM harness.
 *
 * Nothing in this file guesses. A block whose label named no slot offers every slot rather
 * than being coerced into a plausible one — filing text into the wrong field is worse than
 * one extra click — and replacing something already filed always costs a second click.
 */

import { CARD_SLOTS, type CardSlot } from '@shared/types/cocreator.ts';
import type { MenuEntry } from '../../components/Menu.tsx';
import { SLOT_LABELS } from './blocks.ts';

export const BUSY_REASON = 'Generating a reply';
export const EMPTY_REASON = 'Nothing to file';
export const NO_SELECTION_REASON = 'Select some text in this message first';

export interface UseAsMenuState {
  /** The slot the block named, or null for prose, a whole message, or an unknown label. */
  slot: CardSlot | null;
  /** The text that would be filed. Blank disables every entry. */
  text: string;
  /** A generation is running: filing now would race the text it is writing. */
  busy: boolean;
  /** Which single-value slots already hold something — those arm a confirm. */
  filled: (slot: CardSlot) => boolean;
  /** The slot whose replace is currently armed, if any. */
  confirming: CardSlot | null;
  /** Set for the "Use selection as" variant, so an empty selection explains itself. */
  requiresSelection?: boolean;
}

export interface UseAsMenuActions {
  onUse: (slot: CardSlot) => void;
  /** Arm the two-click confirm for a slot that already holds something. */
  onArmConfirm: (slot: CardSlot) => void;
}

/**
 * Offer the block's own slot first, then the rest.
 *
 * A block that named a slot is almost always going where it says, so that entry sits under
 * the cursor. The others stay available because a model mislabels, and because a greeting the
 * user likes better than the one already filed becomes an alternate rather than a replacement.
 */
function slotOrder(slot: CardSlot | null): CardSlot[] {
  if (!slot) return [...CARD_SLOTS];
  return [slot, ...CARD_SLOTS.filter((candidate) => candidate !== slot)];
}

export function buildUseAsMenu(state: UseAsMenuState, actions: UseAsMenuActions): MenuEntry[] {
  const blank = !state.text.trim();
  const blockedReason = state.busy
    ? BUSY_REASON
    : blank
      ? state.requiresSelection
        ? NO_SELECTION_REASON
        : EMPTY_REASON
      : undefined;

  const entries: MenuEntry[] = [];
  const ordered = slotOrder(state.slot);

  ordered.forEach((slot, index) => {
    // A separator after the block's own slot, so "the obvious one" reads as a distinct
    // choice rather than the first of eleven.
    if (index === 1 && state.slot) entries.push({ kind: 'separator' });

    const armed = state.confirming === slot;
    const replaces = state.filled(slot);

    entries.push({
      label: SLOT_LABELS[slot],
      key: slot,
      disabled: Boolean(blockedReason),
      ...(blockedReason ? { disabledReason: blockedReason } : {}),
      ...(armed
        ? { description: 'Click again to replace what is filed', danger: true }
        : replaces
          ? { hint: 'replaces' }
          : {}),
      // Two-click confirm in place, not a dialog. `keepOpen` is what lets the first click
      // arm the entry and leave the menu up for the second.
      keepOpen: replaces && !armed,
      onSelect: () => {
        if (replaces && !armed) actions.onArmConfirm(slot);
        else actions.onUse(slot);
      },
    });
  });

  return entries;
}
