import { useEffect, useRef, useState } from 'react';
import { EditIcon } from '../../layout/icons.tsx';

/**
 * A model's thinking, boxed above the reply it produced.
 *
 * Shared by the streaming and settled paths rather than duplicated in each. Two copies of
 * a collapsible with a styled label would drift the moment one gained a feature, and the
 * drift would be invisible — you would have to stream a reply to notice.
 *
 * The label is fixed rather than timed. Reasoning duration is not recorded anywhere —
 * only whole-generation start and finish are — and inferring it from those would be a
 * guess dressed up as a measurement.
 *
 * Editing is its own mode, deliberately not folded into the message editor: a model can
 * put its actual answer in the thinking block, and the user needs a way to lift that text
 * out without the reply's markdown getting in the way. The editor only exists while the
 * box is expanded, which is the only time there is anything to edit.
 */
export function Reasoning({
  text,
  defaultOpen = false,
  onEdit,
}: {
  text: string;
  defaultOpen?: boolean;
  /** Absent on the streaming path, where the thinking is still arriving. */
  onEdit?: (text: string) => void;
}) {
  // Controlled so `defaultOpen` can differ per mount, but still user-toggleable from there.
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // preventScroll: the click that opened the editor already proves the box is on
    // screen, and a plain focus() makes the browser "reveal" the fresh textarea by
    // jumping the whole transcript.
    if (editing) textarea.current?.focus({ preventScroll: true });
  }, [editing]);

  if (!text) return null;

  function startEditing() {
    setDraft(text);
    setEditing(true);
  }

  function commit() {
    if (draft !== text) onEdit?.(draft);
    setEditing(false);
  }

  return (
    <details
      className="reasoning"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="reasoning__summary">Thought for some time</summary>
      {editing ? (
        <div className="reasoning__editor">
          <textarea
            ref={textarea}
            className="wc-textarea reasoning__input"
            value={draft}
            rows={Math.min(20, Math.max(3, draft.split('\n').length + 1))}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false);
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commit();
            }}
          />
          <div className="reasoning__editor-actions">
            <button type="button" className="wc-button wc-button--primary" onClick={commit}>
              Save
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <span className="wc-hint">⌘↵ to save, Esc to cancel</span>
          </div>
        </div>
      ) : (
        <>
          <div className="reasoning__body">{text}</div>
          {onEdit ? (
            <div className="reasoning__tools">
              <button
                type="button"
                className="wc-button wc-button--ghost reasoning__edit"
                onClick={startEditing}
                title="Edit reasoning"
                aria-label="Edit reasoning"
              >
                <EditIcon />
              </button>
            </div>
          ) : null}
        </>
      )}
    </details>
  );
}
