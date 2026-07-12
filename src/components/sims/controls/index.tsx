import type { ReactNode } from 'react';
import './controls.css';

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  format = String,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="sim-control sim-slider">
      <span className="sim-control-label">
        {label} <output>{format(value)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="sim-control sim-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="sim-control-label">{label}</span>
    </label>
  );
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="sim-control" role="group" aria-label={label}>
      <span className="sim-control-label">{label}</span>
      <div className="sim-segments">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={opt.value === value ? 'active' : ''}
            aria-pressed={opt.value === value}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Button({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="sim-button" onClick={onClick}>
      {children}
    </button>
  );
}

export function Readout({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="sim-readout">
      <span className="sim-readout-value">{value}</span>
      <span className="sim-readout-label">{label}</span>
    </div>
  );
}
