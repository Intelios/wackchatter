import { useState } from 'react';

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
 */
export function Reasoning({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  // Controlled so `defaultOpen` can differ per mount, but still user-toggleable from there.
  const [open, setOpen] = useState(defaultOpen);

  if (!text) return null;

  return (
    <details
      className="reasoning"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="reasoning__summary">Thought for some time</summary>
      <div className="reasoning__body">{text}</div>
    </details>
  );
}
