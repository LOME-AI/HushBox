import { useEffect, useRef } from 'react';
import { runAnimationFrameLoop } from './run-animation-frame-loop';

interface UseAnimationFrameOptions {
  /** When true, respect the merged reduced-motion signal. Default true. */
  respectMotion?: boolean;
  /** When true, hook is paused (no rAF callbacks). Default false. */
  paused?: boolean;
}

/**
 * useAnimationFrame — accessibility-aware wrapper around requestAnimationFrame.
 * Use this instead of raw window.requestAnimationFrame for any JS-driven animation.
 *
 * When respectMotion is true (default), the loop pauses whenever the merged
 * reduced-motion signal is on and resumes when it turns off — same single
 * source of truth as `useReducedMotion()` and the `html.reduced-motion` class.
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
    // The block body keeps a callback that happens to return `false` from ending the loop.
    return runAnimationFrameLoop(
      (timestamp) => {
        callbackRef.current(timestamp);
      },
      { respectMotion }
    );
  }, [paused, respectMotion]);
}
