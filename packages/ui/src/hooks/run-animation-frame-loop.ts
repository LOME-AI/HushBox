import { shouldReduceMotion, subscribeReducedMotion } from './use-reduced-motion';

interface AnimationFrameLoopOptions {
  /** When true, the loop pauses while the merged reduced-motion signal is on. Default true. */
  respectMotion?: boolean;
}

function noop(): void {
  /* The unsubscribe of a loop that never subscribed. */
}

/**
 * Calls `tick` once per animation frame until the tick returns `false` or the returned
 * disposer runs. The one sanctioned requestAnimationFrame site: React code reaches it
 * through `useAnimationFrame`, and a plain script (an Astro page's) calls it directly.
 *
 * With `respectMotion` on, the loop starts only while motion is allowed and pauses and
 * resumes with the same merged reduced-motion signal that sets `html.reduced-motion`.
 */
export function runAnimationFrameLoop(
  tick: (timestamp: number) => boolean | undefined,
  options: AnimationFrameLoopOptions = {}
): () => void {
  const { respectMotion = true } = options;
  let frameId: number | null = null;
  let ended = false;
  let unsubscribe = noop;

  const stop = (): void => {
    if (frameId === null) return;
    globalThis.cancelAnimationFrame(frameId);
    frameId = null;
  };

  const dispose = (): void => {
    ended = true;
    stop();
    unsubscribe();
  };

  const frame = (timestamp: number): void => {
    frameId = null;
    if (tick(timestamp) === false) {
      dispose();
      return;
    }
    if (!ended) frameId = globalThis.requestAnimationFrame(frame);
  };

  // Runs only from a stopped state: at the outset, or when the reduced-motion subscriber,
  // which fires on flips alone, reports motion allowed again after it stopped the loop.
  const start = (): void => {
    frameId = globalThis.requestAnimationFrame(frame);
  };

  if (!respectMotion) {
    start();
    return dispose;
  }

  unsubscribe = subscribeReducedMotion((reduced) => {
    if (reduced) stop();
    else start();
  });
  if (!shouldReduceMotion()) start();
  return dispose;
}
