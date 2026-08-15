/**
 * The card, on the avatar it belongs to.
 *
 * The trigger is a picture already on screen beside every line the character speaks, which
 * is the whole argument for putting it here: the feature costs the transcript no permanent
 * chrome, and the thing you click is the thing you are asking about. A click rather than a
 * hover, deliberately — a card that opened itself while you were reading past it would be
 * worse than the six-click trip it replaces.
 *
 * The card reaches this through a store rather than a prop. Message bubbles are memoised so
 * a long chat does not repaint on every keystroke elsewhere, and `setDetail` fires on every
 * character-editor autosave — see `state/cardStore.ts` for what a plain prop would cost.
 * Only the body subscribes, and the body only exists while the popup is open.
 */

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Popover } from '../../components/Popover.tsx';
import { EditIcon, ExpandIcon } from '../../layout/icons.tsx';
import type { CardReaderInit } from './CardReader.tsx';
import { CardSheetView, useCardSheetState } from './CardSheetView.tsx';
import { type CardSheet, readCardSheet } from './cardSheet.ts';
import type { CardStore } from './state/cardStore.ts';
import './CardSheetPopover.css';

/** Room left around the popup when its width is capped to the column. */
const GUTTER = 8;

/** Before the card lands, and if a teardown race ever empties the store while open. */
const NO_CARD: CardSheet = {
  rung: 'raw',
  sections: [{ id: 'card', label: 'Card', text: '', source: { kind: 'card' } }],
};

interface CardSheetPopoverProps {
  store: CardStore;
  /** The speaker's name, for the trigger's label and the fallback initial. */
  name: string;
  avatarUrl: string | null;
  /** Leaves the chat for the character editor. Absent means the action is not offered. */
  onEditCharacter?: () => void;
  /** Hands the sheet's place over to the full reader. Absent hides the Expand button. */
  onOpenReader?: (init: CardReaderInit) => void;
  /** A generation is running, which makes leaving for the editor destructive. */
  busy?: boolean;
}

export function CardSheetPopover({
  store,
  name,
  avatarUrl,
  onEditCharacter,
  onOpenReader,
  busy,
}: CardSheetPopoverProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  /*
   * Cap the width to the column, the way Popover caps the height to it.
   *
   * Popover flips sides when there is no room above or below, but it has no horizontal
   * equivalent, and `.chat-view__scroll` is `overflow-x: hidden` — so a sheet anchored near
   * the left edge of a column narrowed by two open panels would run out of the right of it
   * with no scrollbar to recover the lost edge. Measured from the trigger, since the popup
   * grows rightward from it.
   *
   * Local rather than a change to Popover: this is the only popup in the app wide enough
   * for the column to be the binding constraint.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    const trigger = triggerRef.current;
    if (!popup || !trigger) return;

    let right = window.innerWidth;
    for (let node = popup.parentElement; node; node = node.parentElement) {
      if (getComputedStyle(node).overflowX === 'visible') continue;
      right = node.getBoundingClientRect().right;
      break;
    }

    const room = right - trigger.getBoundingClientRect().left - GUTTER;
    // A floor, so a pathologically narrow column produces a cramped sheet rather than an
    // unusable sliver.
    popup.style.maxWidth = `${Math.max(room, 240)}px`;
  }, [open]);

  return (
    <Popover
      label={`${name}'s card`}
      icon={null}
      open={open}
      onOpenChange={setOpen}
      popupClassName="card-sheet-popup"
      popupRef={popupRef}
      // Down and to the right of the avatar, which sits at the bubble's top-left. Popover
      // flips it upward near the bottom of the window.
      placement="bottom-start"
      role="dialog"
      className="message__card"
      /*
       * Deliberately NOT the built-in trigger, and deliberately not carrying the
       * `popover__trigger` class: MessageBubble.css has a `:has(.popover__trigger[aria-expanded="true"])`
       * rule that pins a row's Edit/⋯ tools visible while a popup is open, which is right
       * for the row's own menu and wrong for this — opening the card would light up
       * controls the reader did not ask for.
       *
       * `triggerRef` is not passed either: Popover prefers an external ref but only ever
       * writes the internal one from `renderTrigger`, so passing both leaves it null and
       * silently costs the flip and the height cap.
       */
      renderTrigger={(props) => (
        <button
          {...props}
          ref={(node) => {
            props.ref(node);
            triggerRef.current = node;
          }}
          type="button"
          className="message__avatar message__avatar--card"
          onClick={() => setOpen(!open)}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" />
          ) : (
            <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
          )}
        </button>
      )}
    >
      <CardSheetBody
        store={store}
        onEditCharacter={onEditCharacter}
        // Carries the reader your place rather than restarting it at the top, and shuts the
        // popover behind you — two copies of the same card, one over the other, would leave
        // no way to tell which one your next keystroke goes to.
        onExpand={
          onOpenReader
            ? (init) => {
                setOpen(false);
                onOpenReader(init);
              }
            : undefined
        }
        busy={busy}
      />
    </Popover>
  );
}

interface CardSheetBodyProps {
  store: CardStore;
  onEditCharacter?: () => void;
  onExpand?: (init: CardReaderInit) => void;
  busy?: boolean;
}

/**
 * The one subscriber.
 *
 * Mounted only while the popup is open — `Popover` renders its children on open — so a
 * closed sheet costs nothing at all, and an open one re-renders only itself.
 */
function CardSheetBody({ store, onEditCharacter, onExpand, busy }: CardSheetBodyProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sheet = useMemo(
    () => (snapshot.card ? readCardSheet(snapshot.card, snapshot.render) : NO_CARD),
    [snapshot.card, snapshot.render],
  );
  const state = useCardSheetState(sheet, snapshot.avatar);

  return (
    <CardSheetView
      sheet={sheet}
      variant="popover"
      {...state}
      actions={
        <>
          {onExpand ? (
            <button
              type="button"
              className="wc-button wc-button--ghost card-sheet__action"
              title="Read at full width"
              aria-label="Read this card at full width"
              onClick={() => onExpand({ query: state.query, sectionId: state.sectionId })}
            >
              <ExpandIcon />
            </button>
          ) : null}
          {onEditCharacter ? (
            <button
              type="button"
              className="wc-button wc-button--ghost card-sheet__action"
              // Disabled beats refused: leaving for the editor aborts the generation, so
              // mid-stream this would silently throw away the reply being written.
              disabled={busy}
              title={busy ? 'Wait for the current reply to finish.' : 'Edit this card'}
              aria-label="Edit this card"
              onClick={onEditCharacter}
            >
              <EditIcon />
            </button>
          ) : null}
        </>
      }
    />
  );
}
