import { useId } from 'react';
import './Field.css';

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  rows?: number;
  /** Shown to the right of the label, e.g. a token count. */
  meta?: string;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline,
  rows = 4,
  meta,
}: TextFieldProps) {
  const id = useId();

  return (
    <div className="field">
      <div className="field__head">
        <label className="wc-label" htmlFor={id}>
          {label}
        </label>
        {meta ? <span className="field__meta">{meta}</span> : null}
      </div>

      {multiline ? (
        <textarea
          id={id}
          className="wc-textarea"
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="wc-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {hint ? <p className="wc-hint">{hint}</p> : null}
    </div>
  );
}

interface TagFieldProps {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  hint?: string;
}

/** Comma-separated editing for string arrays (tags). */
export function TagField({ label, value, onChange, hint }: TagFieldProps) {
  const id = useId();

  return (
    <div className="field">
      <label className="wc-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="wc-input"
        type="text"
        value={value.join(', ')}
        placeholder="fantasy, adventure"
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
          )
        }
      />
      {hint ? <p className="wc-hint">{hint}</p> : null}
    </div>
  );
}

interface ListFieldProps {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  addLabel: string;
  hint?: string;
  placeholder?: string;
}

/** An editable list of long strings — used for alternate greetings. */
export function ListField({ label, value, onChange, addLabel, hint, placeholder }: ListFieldProps) {
  function update(index: number, next: string) {
    const copy = [...value];
    copy[index] = next;
    onChange(copy);
  }

  return (
    <div className="field">
      <div className="field__head">
        <span className="wc-label">{label}</span>
        <span className="field__meta">{value.length}</span>
      </div>

      {value.map((item, index) => (
        // Index keys are correct here: entries are positional and reorderable only by
        // add/remove, and the value itself is not unique (two greetings can match).
        // biome-ignore lint/suspicious/noArrayIndexKey: positional list
        <div className="list-field__row" key={index}>
          <textarea
            className="wc-textarea"
            value={item}
            rows={3}
            placeholder={placeholder}
            onChange={(e) => update(index, e.target.value)}
            aria-label={`${label} ${index + 1}`}
          />
          <button
            type="button"
            className="wc-button wc-button--ghost wc-button--danger"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            aria-label={`Remove ${label} ${index + 1}`}
          >
            Remove
          </button>
        </div>
      ))}

      <button type="button" className="wc-button" onClick={() => onChange([...value, ''])}>
        {addLabel}
      </button>

      {hint ? <p className="wc-hint">{hint}</p> : null}
    </div>
  );
}
