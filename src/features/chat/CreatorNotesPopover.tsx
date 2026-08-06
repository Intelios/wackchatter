/**
 * What the creator said about this card, read at the moment it is needed.
 *
 * Creator notes live in the editor's Metadata section and, read-only, in the Characters
 * panel — both fine for "what is this card", both useless for the question actually being
 * asked at the top of a fresh chat: the swiper says 4/10, so what is number four? Cards
 * with alternate greetings answer that in their notes and nowhere else.
 *
 * So the trigger sits in the greeting's swipe group, beside the counter it explains. It is
 * there only while the greeting is still the last message — see `canReply` in
 * `MessageBubble` — which is exactly the window in which greetings are being chosen, and
 * costs the transcript no permanent chrome once the chat is under way.
 *
 * When the notes resolve into one line per greeting the list is numbered to match the
 * counter and the current one is marked. When they do not, they render whole, which is all
 * the Characters panel ever offered.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { Popover } from '../../components/Popover.tsx';
import { NotesIcon } from '../../layout/icons.tsx';
import { readScenarioNotes } from './creatorNotes.ts';
import { Markdown } from './Markdown.tsx';
import './CreatorNotesPopover.css';

interface CreatorNotesPopoverProps {
  notes: string;
  /** How many of the message's swipes came from the card, in order. */
  greetingCount: number;
  /** The swipe on show, so its line can be marked. Past `greetingCount` it is a re-roll. */
  swipeIndex: number;
}

export function CreatorNotesPopover({
  notes,
  greetingCount,
  swipeIndex,
}: CreatorNotesPopoverProps) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  const { intro, scenarios, outro } = readScenarioNotes(notes, greetingCount);
  // A re-rolled greeting is a swipe the card never wrote, so nothing in the list is it.
  const current = swipeIndex < scenarios.length ? swipeIndex : -1;

  /*
   * Open on the line you swiped to.
   *
   * Ten scenarios do not fit the popup, so opening at the top means scrolling to hunt for
   * the highlight — the exact hunt this popover exists to end. Also re-runs while open, so
   * swiping behind it (nothing here is modal) tracks.
   *
   * scrollTop rather than scrollIntoView: this popup sits inside the scrolling transcript,
   * and scrollIntoView is entitled to scroll every ancestor to satisfy the request. It
   * would drag the conversation out from under the popup to reveal a line inside it.
   *
   * Layout effect for the same reason it is one in Popover: the popup's max-height is set
   * there, and that is the child, so it has already run by the time this does — the scroll
   * lands on the first painted frame instead of flashing the top of the list.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: current is the trigger, read through the ref
  useLayoutEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    const item = currentRef.current;
    if (!popup || !item) return;
    // Centred where there is room; the browser clamps at both ends, so the first and last
    // entries simply sit against their edge rather than being dragged into the middle.
    popup.scrollTop = item.offsetTop - (popup.clientHeight - item.offsetHeight) / 2;
  }, [open, current]);

  return (
    <Popover
      label="Creator notes"
      icon={<NotesIcon />}
      open={open}
      onOpenChange={setOpen}
      popupClassName="creator-notes"
      popupRef={popupRef}
      // The greeting's footer is at the right edge of the bubble and the transcript
      // scrolls under a fixed composer, so the popup grows up and back over the message.
      placement="top-end"
      role="dialog"
      className="message__notes"
    >
      <div className="creator-notes__head">
        <h2 className="creator-notes__title">Creator notes</h2>
        {current >= 0 ? (
          <p className="creator-notes__hint">
            Greeting {current + 1} of {scenarios.length} is highlighted.
          </p>
        ) : null}
      </div>

      <div className="creator-notes__body">
        {intro ? <Markdown text={intro} /> : null}

        {scenarios.length > 0 ? (
          <ol className="creator-notes__scenarios">
            {scenarios.map((scenario, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: positional greeting list
                key={index}
                ref={index === current ? currentRef : undefined}
                className="creator-notes__scenario"
                data-current={index === current || undefined}
                aria-current={index === current ? 'true' : undefined}
              >
                <Markdown text={scenario} />
              </li>
            ))}
          </ol>
        ) : null}

        {outro ? <Markdown text={outro} /> : null}
      </div>
    </Popover>
  );
}
