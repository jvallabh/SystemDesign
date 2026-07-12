import { useEffect, useRef, type ReactNode } from 'react';
import './simframe.css';

/**
 * Uniform chrome for every simulation: header with title + play/pause + reset,
 * SVG canvas area, controls rail, and a readout strip. Renders meaningful
 * static markup server-side so islands don't cause layout shift.
 */
export function SimFrame({
  title,
  playing,
  onPlayPause,
  onReset,
  controls,
  readouts,
  children,
}: {
  title: string;
  playing: boolean;
  onPlayPause: () => void;
  onReset: () => void;
  controls?: ReactNode;
  readouts?: { label: string; value: string | number }[];
  children: ReactNode;
}) {
  // Respect prefers-reduced-motion: sims autoplay by default, so pause once
  // after hydration for users who opt out of motion (they can still press
  // play). Runs post-mount only — server and client initial markup stay
  // identical. The ref guards against re-runs (prop changes, StrictMode).
  const checkedReducedMotion = useRef(false);
  useEffect(() => {
    if (checkedReducedMotion.current) return;
    checkedReducedMotion.current = true;
    if (playing && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onPlayPause();
    }
  }, [playing, onPlayPause]);

  return (
    <section className="sim-frame" aria-label={`${title} simulation`}>
      <header className="sim-header">
        <h3>{title}</h3>
        <div className="sim-header-actions">
          <button type="button" onClick={onPlayPause} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" onClick={onReset} aria-label="Reset">
            ↺
          </button>
        </div>
      </header>
      <div className="sim-body">
        <div className="sim-canvas">{children}</div>
        {controls && <div className="sim-controls">{controls}</div>}
      </div>
      {readouts && readouts.length > 0 && (
        <footer className="sim-readouts">
          {readouts.map((r) => (
            <div className="sim-readout" key={r.label}>
              <span className="sim-readout-value">{r.value}</span>
              <span className="sim-readout-label">{r.label}</span>
            </div>
          ))}
        </footer>
      )}
    </section>
  );
}
