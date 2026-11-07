/**
 * The Studio's fields: writing surfaces that show macros as chips, a tag line, and the one
 * line an empty optional field folds to.
 */

import { type ReactNode, useMemo, useState } from 'react';
import { Icon } from './icons.tsx';
import { macroParts } from './studio.ts';

/**
 * A text you write in, with every `{{macro}}` drawn as a chip and an unknown one marked
 * where it is.
 *
 * A real textarea does the editing, transparent, over a copy of its text that does the
 * drawing. Both share every metric, so the chips sit exactly under the letters they
 * colour, and typing, selection, undo and pasting stay the browser's own. The copy sets
 * the height, so the field grows with what is written and never scrolls inside itself.
 */
export function MacroText({
  value,
  onChange,
  label,
  placeholder,
  variant = 'text',
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  /** `prose` for long writing, `text` for prompts and notes. */
  variant?: 'prose' | 'text';
  autoFocus?: boolean;
}) {
  const parts = useMemo(() => macroParts(value), [value]);
  return (
    <div className={`w3-mt w3-mt--${variant}`}>
      <div className="w3-mt__back" aria-hidden="true">
        {parts.map((part, index) =>
          part.macro === undefined ? (
            part.text
          ) : (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and redrawn whole
              key={index}
              className="w3-mt__mac"
              data-bad={!part.macro || undefined}
            >
              {part.text}
            </span>
          ),
        )}
        {/* A last empty line still takes room, as it does in the textarea. */}
        {value.endsWith('\n') || !value ? ' ' : null}
      </div>
      <textarea
        className="w3-mt__in"
        value={value}
        rows={1}
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        // biome-ignore lint/a11y/noAutofocus: opened on purpose, by a click on its folded line
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** A field's label, with its token count on the right. */
export function FieldHead({ label, tokens }: { label: string; tokens?: number }) {
  return (
    <div className="w3-st-label">
      <span>{label}</span>
      {tokens !== undefined ? (
        <span className="w3-st-label__n">
          <b>{tokens.toLocaleString()}</b> tokens
        </span>
      ) : null}
    </div>
  );
}

/** An empty optional field, folded to one line until you write in it. */
export function FoldLine({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button type="button" className="w3-st-fold" onClick={onOpen}>
      <Icon name="plus" size="xs" />
      {label}
    </button>
  );
}

/**
 * Text fields that fold away while empty. One opened by its line stays open until the card
 * is left, even emptied again, so clearing it never yanks it from under the cursor.
 */
export function FoldingFields({
  fields,
  render,
}: {
  fields: readonly { key: string; label: string; value: string }[];
  render: (key: string, autoFocus: boolean) => ReactNode;
}) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const shown = fields.filter((field) => field.value.trim() || opened.has(field.key));
  const folded = fields.filter((field) => !field.value.trim() && !opened.has(field.key));
  return (
    <>
      {shown.map((field) => (
        <div key={field.key} className="w3-st-field">
          {render(field.key, focus === field.key)}
        </div>
      ))}
      {folded.length ? (
        <div className="w3-st-folds">
          {folded.map((field) => (
            <FoldLine
              key={field.key}
              label={field.label}
              onOpen={() => {
                setOpened((current) => new Set(current).add(field.key));
                setFocus(field.key);
              }}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Words as chips: Enter or a comma adds one, × takes one away. */
export function ChipList({
  values,
  onChange,
  label,
  placeholder,
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
  label: string;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const word = draft.trim();
    if (word && !values.includes(word)) onChange([...values, word]);
    setDraft('');
  };
  return (
    <div className="w3-st-chips">
      {values.map((value, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a value's place is its identity here
        <span key={`${value}-${index}`} className="w3-st-chip">
          {value}
          <button
            type="button"
            aria-label={`Remove ${value}`}
            onClick={() => onChange(values.filter((_, at) => at !== index))}
          >
            <Icon name="close" size="xs" />
          </button>
        </span>
      ))}
      <input
        className="w3-st-chips__in"
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            add();
          }
          if (event.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

/** A one-line text input that commits when you leave it, Enter included; Esc puts it back. */
export function LineInput({
  value,
  onCommit,
  label,
  placeholder,
  className = 'w3-st-input',
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [was, setWas] = useState(value);
  if (value !== was) {
    setWas(value);
    setDraft(value);
  }
  return (
    <input
      className={className}
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(value);
        }
      }}
    />
  );
}
