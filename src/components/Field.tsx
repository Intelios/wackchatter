import { joinKeys, splitKeys } from '@shared/worldinfo/keys.ts';
import { useEffect, useId, useState } from 'react';
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
  /**
   * Called on blur, and on Enter for a single-line field. For edits whose side effect is
   * too heavy to run per keystroke — a rename that moves a file, say.
   */
  onCommit?: () => void;
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
  onCommit,
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
          onBlur={onCommit}
        />
      ) : (
        <input
          id={id}
          className="wc-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onCommit) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
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

interface KeyFieldProps {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  hint?: string;
}

/**
 * Comma-separated editing for World Info keys.
 *
 * NOT TagField. `/foo,bar/i` is one legal key — a regex literal — and TagField's plain
 * `split(',')` would turn it into two keys that match nothing. `splitKeys` knows the
 * difference; see shared/worldinfo/keys.ts.
 *
 * Keeps a local text buffer so a half-typed `/pattern` isn't re-serialised out from under
 * the cursor on every keystroke.
 */
export function KeyField({ label, value, onChange, placeholder, hint }: KeyFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => joinKeys(value));

  // Follow the value when it changes from outside (a different entry selected), but not
  // when the change came from this input — that would fight the cursor.
  useEffect(() => {
    setDraft((current) =>
      splitKeys(current).join('\u0000') === value.join('\u0000') ? current : joinKeys(value),
    );
  }, [value]);

  return (
    <div className="field">
      <label className="wc-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="wc-input"
        type="text"
        value={draft}
        placeholder={placeholder ?? 'castle, dragon, /wyrm(s)?/i'}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(splitKeys(event.target.value));
        }}
      />
      {hint ? <p className="wc-hint">{hint}</p> : null}
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** Shown when the box is empty. */
  placeholder?: string;
}

/**
 * A number input that can be emptied.
 *
 * The local string buffer is the whole point: bind a number straight to an input and
 * clearing the box produces `Number('') === 0`, which writes a real zero into the model
 * and immediately re-renders "0" back into the field. You cannot delete the leading digit
 * to type a new one. The buffer lets the box be empty while the model keeps its last
 * valid value.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  placeholder,
}: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => String(value));

  useEffect(() => {
    setDraft((current) =>
      Number(current) === value && current.trim() !== '' ? current : String(value),
    );
  }, [value]);

  return (
    <div className="field">
      <label className="wc-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="wc-input"
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = Number(event.target.value);
          if (event.target.value.trim() !== '' && Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={() => {
          // Restore the last good value rather than leaving a blank box that disagrees
          // with what is actually stored.
          if (draft.trim() === '' || !Number.isFinite(Number(draft))) setDraft(String(value));
        }}
      />
      {hint ? <p className="wc-hint">{hint}</p> : null}
    </div>
  );
}

interface SelectOption<T> {
  label: string;
  value: T;
}

interface SelectFieldProps<T> {
  label: string;
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  hint?: string;
}

/**
 * A select over arbitrary values, keyed by index.
 *
 * The index indirection is required, not incidental: `WiPosition`, `WiLogic` and `WiRole`
 * are numeric enums that include 0, and an `<option value={0}>` round-trips through the
 * DOM as the string "0". Mapping back through `options` by index keeps the real value —
 * including `false`, `0` and `null` — instead of guessing at a parse.
 */
export function SelectField<T>({ label, value, options, onChange, hint }: SelectFieldProps<T>) {
  const id = useId();
  const selected = options.findIndex((option) => option.value === value);

  return (
    <div className="field">
      <label className="wc-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="wc-select"
        value={selected === -1 ? '' : String(selected)}
        onChange={(event) => {
          const option = options[Number(event.target.value)];
          if (option) onChange(option.value);
        }}
      >
        {selected === -1 ? <option value="">—</option> : null}
        {options.map((option, index) => (
          <option key={option.label} value={index}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <p className="wc-hint">{hint}</p> : null}
    </div>
  );
}

interface CheckFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}

export function CheckField({ label, checked, onChange, hint }: CheckFieldProps) {
  const id = useId();

  return (
    <div className="field field--check">
      <label className="check-field" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint ? <p className="wc-hint">{hint}</p> : null}
    </div>
  );
}

interface TriCheckFieldProps {
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  /** What null resolves to, shown on the Inherit option. */
  inherited: boolean;
  hint?: string;
}

/**
 * Three-state: on, off, or inherit the global setting.
 *
 * Required rather than a nicety. `caseSensitive` and `matchWholeWords` are `boolean|null`
 * where null means "follow the global setting", and a plain checkbox has nowhere to put
 * that — so merely opening an entry and toggling anything would silently pin it away from
 * the global, and changing the global later would no longer affect it.
 */
export function TriCheckField({ label, value, onChange, inherited, hint }: TriCheckFieldProps) {
  return (
    <SelectField<boolean | null>
      label={label}
      value={value}
      options={[
        { label: `Inherit (${inherited ? 'on' : 'off'})`, value: null },
        { label: 'On', value: true },
        { label: 'Off', value: false },
      ]}
      onChange={onChange}
      hint={hint}
    />
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
