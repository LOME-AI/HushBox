import { afterEach, describe, expect, it, vi } from 'vitest';

import { sampleOnInterval } from './interval-sampler.js';

const INTERVAL_MS = 1000;

/** A read whose landing this test controls, and the hand that lands it. */
function heldRead(): {
  read: () => Promise<number | undefined>;
  land: (reading: number) => void;
  started: () => number;
} {
  let starts = 0;
  let settle: ((reading: number) => void) | undefined;
  return {
    read: () => {
      starts += 1;
      return new Promise<number>((resolve) => {
        settle = resolve;
      });
    },
    land: (reading) => {
      settle?.(reading);
    },
    started: () => starts,
  };
}

describe('sampleOnInterval', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads once up front, so a run shorter than the interval is sampled at all', async () => {
    vi.useFakeTimers();
    const held = heldRead();
    const sampler = sampleOnInterval(held.read, INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(held.started()).toBe(1);
    sampler.stop();
  });

  it('starts no second read while one it already asked for is outstanding', async () => {
    vi.useFakeTimers();
    const held = heldRead();
    const sampler = sampleOnInterval(held.read, INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS + 1);
    expect(held.started()).toBe(1);
    sampler.stop();
  });

  it('resumes reading once the outstanding one has landed', async () => {
    vi.useFakeTimers();
    const held = heldRead();
    const sampler = sampleOnInterval(held.read, INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS + 1);
    held.land(500);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 1);
    expect(held.started()).toBe(2);
    sampler.stop();
  });

  it('leaves the timer unreferenced, so sampling alone does not hold the process open', () => {
    const timers: NodeJS.Timeout[] = [];
    const spy = vi.spyOn(globalThis, 'setInterval');
    const sampler = sampleOnInterval(() => Promise.resolve(70), INTERVAL_MS);
    for (const call of spy.mock.results) {
      if (call.type === 'return') timers.push(call.value);
    }
    expect(timers.map((timer) => timer.hasRef())).toEqual([false]);
    sampler.stop();
    spy.mockRestore();
  });

  it('takes no further read once stopped', async () => {
    vi.useFakeTimers();
    let starts = 0;
    const sampler = sampleOnInterval(() => {
      starts += 1;
      return Promise.resolve(70);
    }, INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    sampler.stop();
    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(starts).toBe(1);
  });
});
