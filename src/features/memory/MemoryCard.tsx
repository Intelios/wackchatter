import type { Memory } from '@shared/types/chat.ts';
import { useEffect, useState } from 'react';
import { KeyField, TextField } from '../../components/Field.tsx';
import { ChevronIcon, EyeIcon, EyeOffIcon, PinIcon, TrashIcon } from '../../layout/icons.tsx';

interface MemoryCardProps {
  memory: Memory;
  /** How many messages this memory is currently hiding. */
  hiddenCount: number;
  /** Messages it covers that are not currently hidden by it. */
  coveredCount: number;
  onChange: (patch: Partial<Memory>) => void;
  onDelete: () => void;
  onSetHidden: (hidden: boolean) => void;
  disabled?: boolean;
}

const STALE_LABEL: Record<NonNullable<Memory['stale']>, string> = {
  edited: 'A message this was written from has been edited since.',
  deleted: 'A message this was written from has been deleted since.',
};

export function MemoryCard({
  memory,
  hiddenCount,
  coveredCount,
  onChange,
  onDelete,
  onSetHidden,
  disabled,
}: MemoryCardProps) {
  const [open, setOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(memory.title);
  const [textDraft, setTextDraft] = useState(memory.text);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => setTitleDraft(memory.title), [memory.title]);
  useEffect(() => setTextDraft(memory.text), [memory.text]);

  /*
   * Any hand edit clears `stale` and sets `edited`. The badge is a prompt to look, not a
   * lasting property of the memory: once someone has read it against the transcript and
   * decided, re-flagging it would be noise. `edited` is what keeps a future re-extraction
   * from overwriting the result.
   */
  const commit = (patch: Partial<Memory>) => onChange({ ...patch, edited: true, stale: undefined });

  const unrecallable = !memory.pinned && memory.keywords.length === 0;

  return (
    <li className="memory-card" data-disabled={!memory.enabled || undefined}>
      <div className="memory-card__head">
        <button
          type="button"
          className="memory-card__toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <ChevronIcon className={open ? 'memory-card__chevron--open' : undefined} />
          <span className="memory-card__title">{memory.title || 'Untitled memory'}</span>
        </button>

        <button
          type="button"
          className="memory-card__action"
          data-active={memory.pinned || undefined}
          onClick={() => onChange({ pinned: !memory.pinned })}
          disabled={disabled}
          title={
            memory.pinned
              ? 'Pinned: always in the prompt. Click to recall it by keyword instead.'
              : 'Recalled by keyword. Click to pin it into every prompt.'
          }
        >
          <PinIcon />
        </button>

        <button
          type="button"
          className="memory-card__action"
          onClick={() => onSetHidden(hiddenCount === 0)}
          disabled={disabled || (hiddenCount === 0 && coveredCount === 0)}
          title={
            hiddenCount > 0
              ? `Show the ${hiddenCount} message${hiddenCount === 1 ? '' : 's'} this memory hid`
              : coveredCount > 0
                ? `Hide the ${coveredCount} message${coveredCount === 1 ? '' : 's'} this memory covers`
                : 'This memory covers no messages in the current transcript'
          }
        >
          {hiddenCount > 0 ? <EyeIcon /> : <EyeOffIcon />}
        </button>

        {/* Two-click confirm in place: destructive, but never a blocking dialog. */}
        <button
          type="button"
          className="memory-card__action memory-card__action--danger"
          data-confirming={confirmDelete || undefined}
          onClick={() => {
            if (confirmDelete) {
              onDelete();
              setConfirmDelete(false);
            } else {
              setConfirmDelete(true);
            }
          }}
          onBlur={() => setConfirmDelete(false)}
          disabled={disabled}
          title={
            confirmDelete
              ? 'Click again to delete'
              : 'Delete this memory and show any messages it hid'
          }
          aria-label={
            confirmDelete
              ? 'Click again to delete'
              : 'Delete this memory and show any messages it hid'
          }
        >
          <TrashIcon />
        </button>
      </div>

      {!open ? <p className="memory-card__preview">{memory.text}</p> : null}

      <div className="memory-card__meta">
        {memory.pinned ? <span className="memory-card__chip">Pinned</span> : null}
        {hiddenCount > 0 ? (
          <span className="memory-card__chip">{hiddenCount} hidden</span>
        ) : coveredCount > 0 ? (
          <span className="memory-card__chip memory-card__chip--quiet">{coveredCount} covered</span>
        ) : null}
        {memory.source === 'manual' ? (
          <span className="memory-card__chip memory-card__chip--quiet">Written by hand</span>
        ) : null}
        {memory.stale ? (
          <span
            className="memory-card__chip memory-card__chip--warn"
            title={STALE_LABEL[memory.stale]}
          >
            Out of date
          </span>
        ) : null}
        {unrecallable ? (
          <span
            className="memory-card__chip memory-card__chip--warn"
            title="With no keywords and no pin, nothing can bring this memory back. Pin it, or give it a keyword."
          >
            Never recalled
          </span>
        ) : null}
      </div>

      {open ? (
        <div className="memory-card__body">
          <TextField
            label="Title"
            value={titleDraft}
            onChange={setTitleDraft}
            onCommit={() => commit({ title: titleDraft })}
            disabled={disabled}
          />
          <TextField
            label="What happened"
            value={textDraft}
            onChange={setTextDraft}
            onCommit={() => commit({ text: textDraft })}
            multiline
            expandable
            rows={4}
            disabled={disabled}
          />
          <KeyField
            label="Recall keywords"
            value={memory.keywords}
            onChange={(keywords) => commit({ keywords })}
            hint="Any of these appearing in recent messages brings this memory back. A pinned memory ignores them."
          />
          <label className="memory-card__enable">
            <input
              type="checkbox"
              checked={memory.enabled}
              onChange={(event) => onChange({ enabled: event.target.checked })}
              disabled={disabled}
            />
            <span>Use this memory</span>
          </label>
        </div>
      ) : null}
    </li>
  );
}
