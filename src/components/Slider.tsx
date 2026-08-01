import { useId } from 'react';
import './Slider.css';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

/**
 * A slider paired with a number input. The number input is the escape hatch for values
 * the slider's range can't reach precisely — context sizes especially.
 */
export function Slider({ label, value, min, max, step, onChange }: SliderProps) {
  const id = useId();

  function commit(raw: number) {
    if (!Number.isFinite(raw)) return;
    onChange(Math.min(max, Math.max(min, raw)));
  }

  return (
    <div className="slider">
      <div className="slider__head">
        <label className="wc-label" htmlFor={id}>
          {label}
        </label>
        <input
          className="slider__number"
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => commit(Number(e.target.value))}
          aria-label={`${label} value`}
        />
      </div>
      <input
        id={id}
        className="slider__range"
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => commit(Number(e.target.value))}
      />
    </div>
  );
}
