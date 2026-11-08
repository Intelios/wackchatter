/**
 * The character's card, two ways: a glance from the portrait beside a message, and the whole
 * card in the margin, where the chat stays live beside it. Both read the same card store and
 * keep the same place (section and search), so "Read the whole card" picks up where the
 * glance was.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Popover } from '../components/Popover.tsx';
import type { CardReaderInit } from '../features/chat/CardReader.tsx';
import { CardSheetView, useCardSheetState } from '../features/chat/CardSheetView.tsx';
import { type CardSheet, readCardSheet } from '../features/chat/cardSheet.ts';
import type { CardStore } from '../features/chat/state/cardStore.ts';
import { Avatar } from './Avatar.tsx';
import { Icon } from './icons.tsx';

const NO_CARD: CardSheet = {
  rung: 'raw',
  sections: [{ id: 'card', label: 'Card', text: '', source: { kind: 'card' } }],
};

function useSheet(store: CardStore) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sheet = useMemo(
    () => (snapshot.card ? readCardSheet(snapshot.card, snapshot.render) : NO_CARD),
    [snapshot.card, snapshot.render],
  );
  return { snapshot, sheet };
}

// --- The glance ---------------------------------------------------------------------------

export function CardGlance({
  store,
  name,
  avatarUrl,
  line,
  busy,
  onOpenReader,
  onEditCharacter,
}: {
  store: CardStore;
  name: string;
  avatarUrl: string | null;
  /** One line about the character, under the name. */
  line: string;
  busy: boolean;
  onOpenReader: (init: CardReaderInit) => void;
  onEditCharacter: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      label={`${name}'s card`}
      icon={null}
      open={open}
      onOpenChange={setOpen}
      role="dialog"
      placement="bottom-start"
      className="w3-glance-anchor"
      popupClassName="w3-glance"
      renderTrigger={(trigger) => (
        <button
          {...trigger}
          type="button"
          className="w3-msg__face"
          title={`${name}'s card`}
          onClick={() => setOpen((o) => !o)}
        >
          <Avatar url={avatarUrl} name={name} size="md" who="char" />
        </button>
      )}
    >
      <GlanceBody
        store={store}
        name={name}
        avatarUrl={avatarUrl}
        line={line}
        busy={busy}
        onExpand={(init) => {
          setOpen(false);
          onOpenReader(init);
        }}
        onEdit={() => {
          setOpen(false);
          onEditCharacter();
        }}
      />
    </Popover>
  );
}

/** Mounted only while the glance is open, so a closed one costs nothing. */
function GlanceBody({
  store,
  name,
  avatarUrl,
  line,
  busy,
  onExpand,
  onEdit,
}: {
  store: CardStore;
  name: string;
  avatarUrl: string | null;
  line: string;
  busy: boolean;
  onExpand: (init: CardReaderInit) => void;
  onEdit: () => void;
}) {
  const { snapshot, sheet } = useSheet(store);
  const state = useCardSheetState(sheet, snapshot.avatar);
  return (
    <>
      <div className="w3-glance__top">
        {avatarUrl ? <img className="w3-glance__img" src={avatarUrl} alt="" /> : null}
        <div className="w3-glance__who">
          <span className="w3-glance__kicker">Card</span>
          <b className="w3-glance__name">{snapshot.card?.name || name}</b>
          {line ? <p className="w3-glance__line">{line}</p> : null}
        </div>
      </div>
      <CardSheetView sheet={sheet} variant="popover" {...state} />
      <div className="w3-glance__foot">
        <button
          type="button"
          className="w3-glance__read"
          onClick={() => onExpand({ query: state.query, sectionId: state.sectionId })}
        >
          Read the whole card
        </button>
        <button
          type="button"
          className="w3-glance__edit"
          disabled={busy}
          title={busy ? 'Wait for the current reply to finish.' : 'Edit this card'}
          onClick={onEdit}
        >
          <Icon name="pencil" size="sm" />
          Edit
        </button>
      </div>
    </>
  );
}

// --- The reader, in the margin ------------------------------------------------------------

export function CardMargin({
  store,
  init,
  avatarUrl,
  line,
  busy,
  onClose,
  onEditCharacter,
}: {
  store: CardStore;
  init: CardReaderInit;
  avatarUrl: string | null;
  line: string;
  busy: boolean;
  onClose: () => void;
  onEditCharacter: () => void;
}) {
  const { snapshot, sheet } = useSheet(store);
  const state = useCardSheetState(sheet, snapshot.avatar, init);
  const name = snapshot.card?.name || 'Character';

  // Escape closes it from anywhere; the find box keeps the first Escape to clear itself.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="w3-margin w3-reader" data-side="R" aria-label={`${name}'s card`}>
      <header className="w3-margin__head">
        <div className="w3-margin__title">
          <h2>The card</h2>
          <span>Esc closes · the chat stays live</span>
        </div>
        <button
          type="button"
          className="w3-margin__close"
          aria-label="Close the card"
          onClick={onClose}
        >
          <Icon name="close" size="sm" />
        </button>
      </header>
      <div className="w3-margin__body">
        <div className="w3-reader__head">
          {avatarUrl ? <img className="w3-reader__img" src={avatarUrl} alt="" /> : null}
          <div>
            <b className="w3-reader__name">{name}</b>
            {line ? <p className="w3-reader__line">{line}</p> : null}
            <button
              type="button"
              className="w3-reader__edit"
              disabled={busy}
              title={busy ? 'Wait for the current reply to finish.' : 'Edit this card'}
              onClick={onEditCharacter}
            >
              <Icon name="pencil" size="sm" />
              Edit card
            </button>
          </div>
        </div>
        <CardSheetView sheet={sheet} variant="reader" autoFocus {...state} />
      </div>
    </aside>
  );
}
