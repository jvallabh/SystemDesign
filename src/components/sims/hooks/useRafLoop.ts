import { useEffect, useRef } from 'react';

const MAX_DT_MS = 100;

/**
 * Drives a simulation step on requestAnimationFrame while `playing`.
 * dt is clamped so tab switches don't produce giant jumps; the loop
 * pauses while the document is hidden and cancels on unmount.
 */
export function useRafLoop(step: (dtMs: number) => void, playing: boolean) {
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!playing) return;

    let rafId = 0;
    let last = performance.now();

    const tick = (now: number) => {
      if (!document.hidden) {
        stepRef.current(Math.min(now - last, MAX_DT_MS));
      }
      last = now;
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing]);
}
