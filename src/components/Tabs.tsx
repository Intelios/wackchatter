/** A tab strip. Dumb on purpose — the caller owns the state and switches the body. */

import './Tabs.css';

interface TabsProps<T extends string> {
  value: T;
  options: ReadonlyArray<{ label: string; value: T; badge?: string }>;
  onChange: (value: T) => void;
  label: string;
}

export function Tabs<T extends string>({ value, options, onChange, label }: TabsProps<T>) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          className="tabs__tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.badge ? <span className="tabs__badge">{option.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
