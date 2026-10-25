import { memo, type ReactNode, useMemo, useState } from 'react';

/**
 * A `<details>` whose body mounts only while it is open.
 *
 * The conversations that carry these blocks re-render on every turn commit, and a
 * transcript can hold dozens of reports, batches and raw tool exchanges — each with
 * megabytes of JSON behind it. Stringifying all of them on every render, including the
 * ones collapsed behind a summary, is the single largest avoidable cost in this panel.
 * The body is not lazy in the CSS sense: it is simply not there until opened.
 */
export function JsonDetails({
  summary,
  className,
  children,
}: {
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {open ? children : null}
    </details>
  );
}

/**
 * The body's JSON, stringified once per distinct value rather than per render. The
 * values come from immutable session documents, so an open block stays cheap too.
 */
export const JsonPre = memo(function JsonPre({
  value,
  label,
}: {
  value: unknown;
  /** A prefix before the JSON, e.g. `result` for "result: {…}". */
  label?: string;
}) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return (
    <pre>
      {label ? `${label}: ` : ''}
      {text}
    </pre>
  );
});
