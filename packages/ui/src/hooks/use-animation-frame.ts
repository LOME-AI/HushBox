import { useEffect, useRef } from 'react';

interface UseAnimationFrameOptions {
  /** When true, respect prefers-reduced-motion / accessibility settings. Default true. */
  respectMotion?: boolean;
  /** When true, hook is paused (no rAF callbacks). Default false. */
  paused?: boolean;
}

/**
 * useAnimationFrame — accessibility-aware wrapper around requestAnimationFrame.
 * Use this instead of raw window.requestAnimationFrame for any JS-driven animation.
 * It auto-pauses when prefers-reduced-motion is set or when paused=true.
 */
export function useAnimationFrame(
  callback: (timestamp: number) => void,
  options: UseAnimationFrameOptions = {}
): void {
  const { respectMotion = true, paused = false } = options;
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (paused) return;

    if (respectMotion && 'window' in globalThis && 'matchMedia' in globalThis) {
      const mq = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq.matches) return; // reduced motion: don't tick
    }

    let rafId: number;
    function tick(timestamp: number): void {
      callbackRef.current(timestamp);
      rafId = globalThis.requestAnimationFrame(tick);
    }
    rafId = globalThis.requestAnimationFrame(tick);

    return () => {
      globalThis.cancelAnimationFrame(rafId);
    };
  }, [paused, respectMotion]);
}
