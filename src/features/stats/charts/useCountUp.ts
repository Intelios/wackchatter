import { useEffect, useState } from 'react';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * A JS animation is not covered by the reduced-motion token overrides in tokens.css, so it
 * has to ask the same question itself — otherwise the one screen in the app built around
 * motion is the one that ignores the setting.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION).matches;
}

/** Decelerating, so the number lands rather than stopping. */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Count from zero to `target`. Returns `target` immediately under reduced motion, and
 * whenever the target changes mid-flight it restarts from where the eye already is.
 */
export function useCountUp(target: number, durationMs = 900, delayMs = 0): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }

    let frame = 0;
    let started: number | null = null;

    const tick = (now: number) => {
      /*
       * A hidden document throttles rAF to almost nothing, which would strand the number
       * partway while the CSS animations beside it run to completion — they are driven by
       * time, not frames, so they finish whether or not anyone is watching. Match them: if
       * a frame lands while the page is hidden, the count is already over.
       */
      if (document.hidden) {
        setValue(target);
        return;
      }
      started ??= now;
      const elapsed = now - started - delayMs;
      if (elapsed < 0) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const progress = durationMs > 0 ? Math.min(1, elapsed / durationMs) : 1;
      setValue(target * easeOutCubic(progress));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, delayMs]);

  return value;
}
