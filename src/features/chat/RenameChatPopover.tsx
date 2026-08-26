/**
 * Renames the open chat — the burger-menu door onto what `/rename` does from the composer.
 *
 * This is only the form. It opens from the "Rename chat…" entry in the chat menu and
 * anchors to the burger button, the way the quick-commands editor grows from the bolt.
 *
 * Enter (or the button) applies; Escape and clicking away discard — neither path ever
 * blurs a live field into `onCommit`. Click-away closes on `pointerdown`, so the field is
 * gone before the browser moves focus; Escape relies on `Popover` restoring focus to the
 * trigger only after the close has rendered (see its `handleKeyDown`) — until that fix the
 * restore blurred this field while it was still mounted and Escape committed the rename.
 * The apply decision is `nextChatTitle`, pure and pinned beside the menu tests.
 */

import { type RefObject, useEffect, useRef, useState } from 'react';
import { TextField } from '../../components/Field.tsx';
import { Popover } from '../../components/Popover.tsx';
import './RenameChatPopover.css';

/**
 * The next title for a rename, or null when the draft is not one — empty, or already the
 * chat's title. Null means no `chat/renamed` dispatch, so a no-op rename never bumps the
 * revision and never schedules a save. Surrounding whitespace is not part of a title; inner
 * spacing is (a chat title is prose, the same rule `/rename` parses by).
 */
export function nextChatTitle(current: string, draft: string): string | null {
  const trimmed = draft.trim();
  return trimmed && trimmed !== current ? trimmed : null;
}

interface RenameChatPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The burger button this popup grows from. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  title: string;
  onRename: (title: string) => void;
}

export function RenameChatPopover({
  open,
  onOpenChange,
  triggerRef,
  title,
  onRename,
}: RenameChatPopoverProps) {
  return (
    <Popover
      label="Rename chat"
      icon={null}
      open={open}
      onOpenChange={onOpenChange}
      className="popover--editor"
      popupClassName="chat-rename"
      role="dialog"
      triggerRef={triggerRef}
      renderTrigger={() => null}
    >
      {/* Popover mounts its children only while open, so the draft seeds from the current
          title on every visit rather than surviving the last one. */}
      <RenameForm title={title} onRename={onRename} onClose={() => onOpenChange(false)} />
    </Popover>
  );
}

function RenameForm({
  title,
  onRename,
  onClose,
}: {
  title: string;
  onRename: (title: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // The menu selection that opened this restores focus to the trigger button AFTER the
  // action runs, so the field waits one tick to take it. Selected, not just focused: the
  // current title ("New chat" until renamed) is there to be typed over, not appended to.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // The close unmounts the form, so the blur a button click causes and the click itself
  // cannot both commit — whichever lands first takes the rename with it.
  function commit() {
    const next = nextChatTitle(title, draft);
    onClose();
    if (next) onRename(next);
  }

  return (
    <div className="chat-rename__body">
      <div className="chat-rename__head">
        <h2 className="chat-rename__title">Rename chat</h2>
        <p className="chat-rename__hint">
          How this chat is labelled on the start screen. Enter applies; Esc or clicking away
          discards.
        </p>
      </div>

      <TextField
        label="Title"
        value={draft}
        onChange={setDraft}
        placeholder="Name this chat"
        inputRef={inputRef}
        onCommit={commit}
      />

      <button type="button" className="wc-button chat-rename__apply" onClick={commit}>
        Rename
      </button>
    </div>
  );
}
