/**
 * The small controls the 3.0 tools share: labelled groups, rows, switches, segments, sliders
 * and the two-click arm. Styled by `settings.css`, where they started.
 */

import { type CSSProperties, type ReactNode, useRef, useState } from 'react';
import './settings.css';

export function Group({
  label,
  aside,
  setting,
  children,
}: {
  label?: string;
  aside?: ReactNode;
  setting?: string;
  children: ReactNode;
}) {
  return (
    <div className="w3-set__group" data-setting={setting}>
      {label ? (
        <h3 className="w3-set__label">
          {label}
          {aside ? <small>{aside}</small> : null}
        </h3>
      ) : null}
      {children}
    </div>
  );
}

export function Row({
  title,
  hint,
  setting,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  setting?: string;
  children: ReactNode;
}) {
  return (
    <div className="w3-set__row" data-setting={setting}>
      <span className="w3-set__rowtext">
        {title}
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </div>
  );
}

export function Switch({
  on,
  label,
  onChange,
  disabled,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="w3-switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

export function Segments<T extends string>({
  value,
  options,
  label,
  onChange,
  disabled,
  title,
}: {
  value: T | undefined;
  options: readonly (readonly [T, string])[];
  label: string;
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <fieldset className="w3-set__seg" aria-label={label} disabled={disabled} title={title}>
      {options.map(([id, text]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A slider. With `peek`, holding it makes the margin step aside so the chat behind shows the
 * change: everything but this control fades until it is let go.
 */
export function Range({
  label,
  value,
  min,
  max,
  step = 1,
  shown,
  setting,
  peek,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  shown: string;
  setting?: string;
  peek?: boolean;
  onChange: (value: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hold = () => {
    if (!peek) return;
    const root = ref.current?.closest<HTMLElement>('.wc3');
    if (!root || !ref.current) return;
    const held = ref.current;
    root.setAttribute('data-peek', '');
    held.setAttribute('data-held', '');
    const release = () => {
      root.removeAttribute('data-peek');
      held.removeAttribute('data-held');
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className="w3-set__range" ref={ref} data-setting={setting}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ '--fill': fill } as CSSProperties}
        onPointerDown={hold}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <b>{shown}</b>
    </div>
  );
}

/** Two clicks in place: the first arms it, the second does it, leaving disarms it. */
export function useArm() {
  const [armed, setArmed] = useState<string | null>(null);
  return {
    armed,
    press: (key: string, act: () => void) => {
      if (armed === key) {
        setArmed(null);
        act();
      } else setArmed(key);
    },
    disarm: () => setArmed(null),
  };
}
