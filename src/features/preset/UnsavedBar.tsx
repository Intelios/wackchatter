import type { PresetDraft } from './usePresetDraft.ts';
import './UnsavedBar.css';

/**
 * Rendered once, in the left panel's chrome slot outside the scrolling body, so it is
 * present on every left panel — including Connection and Inspect, which do not edit the
 * preset at all. That is deliberate: a dirty preset must never be invisible.
 *
 * Most preset edits happen inside the prompt editor, and a Save button you have to
 * navigate away from to reach is one people lose work to.
 */
export function UnsavedBar({ draft }: { draft: PresetDraft }) {
  if (!draft.dirty) return null;

  return (
    // <output> rather than a div with role="status" — it is the semantic element for it.
    <output className="unsaved-bar">
      <span className="unsaved-bar__text">Unsaved changes</span>
      <button type="button" className="wc-button wc-button--ghost" onClick={draft.revert}>
        Revert
      </button>
      <button
        type="button"
        className="wc-button wc-button--primary"
        onClick={() => void draft.save()}
      >
        Save
      </button>
    </output>
  );
}
