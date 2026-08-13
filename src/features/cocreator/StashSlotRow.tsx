import { useEffect, useRef, useState } from 'react';
import { ChevronIcon, ChevronLeftIcon, EditIcon, TrashIcon } from '../../layout/icons.tsx';

interface StashSlotRowProps {
  label: string;
  text: string;
  /** Where it came from — "take 2 · gpt-5.6-sol", or empty when not recorded. */
  meta: string;
  tokens: number;
  busy: boolean;
  onCommit: (text: string) => void;
  onClear: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

/**
 * One filed slot.
 *
 * Editable in place so an almost-right block does not have to wait for the Studio. The
 * draft is local and commits on blur, the same bargain the card editor's fields make: a
 * keystroke is not a revision, and a revision per keystroke would flood the save queue.
 */
export function StashSlotRow({
  label,
  text,
  meta,
  tokens,
  busy,
  onCommit,
  onClear,
  onMoveUp,
  onMoveDown,
}: StashSlotRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Adopt an outside change — a re-file into this slot — but never while the user is typing
  // into it, which would take the edit out from under them.
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus({ preventScroll: true });
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== text) onCommit(draft);
  }

  return (
    <div className="stash-slot">
      <div className="stash-slot__header">
        <span className="stash-slot__label">{label}</span>
        <span className="stash-slot__tokens">{tokens} tok</span>
        <span className="stash-slot__spacer" />
        {onMoveUp || onMoveDown ? (
          <>
            <button
              type="button"
              className="wc-button wc-button--ghost stash-slot__action"
              onClick={onMoveUp}
              disabled={busy || !onMoveUp}
              data-invisible={!onMoveUp || undefined}
              aria-label="Move up"
              title="Move up — this is the order they become swipes"
            >
              <ChevronLeftIcon />
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost stash-slot__action"
              onClick={onMoveDown}
              disabled={busy || !onMoveDown}
              data-invisible={!onMoveDown || undefined}
              aria-label="Move down"
              title="Move down — this is the order they become swipes"
            >
              <ChevronIcon />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="wc-button wc-button--ghost stash-slot__action"
          onClick={() => setEditing((current) => !current)}
          disabled={busy}
          aria-label={editing ? 'Done editing' : 'Edit'}
          title={editing ? 'Done editing' : 'Edit in place'}
        >
          <EditIcon />
        </button>
        <button
          type="button"
          className="wc-button wc-button--ghost wc-button--danger stash-slot__action"
          data-confirming={confirmClear}
          disabled={busy}
          onClick={() => (confirmClear ? onClear() : setConfirmClear(true))}
          onBlur={() => setConfirmClear(false)}
          aria-label={confirmClear ? 'Click again to clear' : 'Clear'}
          title={confirmClear ? 'Click again to clear' : 'Clear this slot'}
        >
          <TrashIcon />
        </button>
      </div>

      {editing ? (
        <textarea
          ref={inputRef}
          className="wc-textarea stash-slot__input"
          value={draft}
          rows={6}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setDraft(text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <p className="stash-slot__text">{text}</p>
      )}

      {meta ? <span className="stash-slot__meta">{meta}</span> : null}
    </div>
  );
}
