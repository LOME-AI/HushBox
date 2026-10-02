/**
 * Sampling on an interval, for a reading whose cost is worth avoiding.
 *
 * Three behaviours have to hold together for a series of readings taken this
 * way to mean anything, which is why they are one implementation rather than a
 * shape each caller reproduces: a reading is taken up front, so a run shorter
 * than the interval is sampled at all; a tick is skipped rather than queued
 * while a reading is outstanding, so reads never pile onto each other on
 * exactly the busy tree that makes them slow; and the timer is unreferenced, so
 * sampling never holds a process open past the work it was watching.
 *
 * What a reading means, what units it is in, and what is folded out of it
 * belong to the caller: this owns the loop and nothing else, and it keeps
 * nothing across readings. A reading asked for while the caller was live can
 * land after its stop, so a caller that does keep a figure closes its own
 * accumulation at its own stop — which is what `scripts/lib/pool/tree-peak.ts`
 * does, and why it does it there.
 */

interface IntervalSampler {
  /** Stop sampling. A reading already asked for still lands; no further one starts. */
  readonly stop: () => void;
}

/** Sample `read` every `intervalMs` until the caller stops. */
export function sampleOnInterval(
  read: () => Promise<unknown>,
  intervalMs: number
): IntervalSampler {
  let outstanding = false;
  let stopped = false;
  const takeSample = async (): Promise<void> => {
    try {
      await read();
    } finally {
      outstanding = false;
    }
  };
  const take = (): void => {
    if (outstanding || stopped) return;
    outstanding = true;
    void takeSample();
  };
  // Once up front, so a run shorter than the interval is still sampled at all.
  take();
  const timer = setInterval(take, intervalMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
