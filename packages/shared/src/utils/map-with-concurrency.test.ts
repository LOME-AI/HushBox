import { describe, it, expect } from 'vitest';

import { mapWithConcurrency } from './map-with-concurrency.ts';

interface Gate {
  readonly wait: () => Promise<void>;
  readonly release: () => void;
}

function gate(): Gate {
  let open: () => void = () => {
    throw new Error('gate released before it was awaited');
  };
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    wait: () => opened,
    release: () => {
      open();
    },
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

describe('mapWithConcurrency', () => {
  it('returns results in input order when mappers complete in reverse order', async () => {
    const gates = [gate(), gate(), gate()];
    const pending = mapWithConcurrency(['a', 'b', 'c'], 3, async (item, index) => {
      await gates[index]?.wait();
      return item.toUpperCase();
    });

    await settleMicrotasks();
    for (const entry of gates.toReversed()) {
      entry.release();
      await settleMicrotasks();
    }

    expect(await pending).toEqual(['A', 'B', 'C']);
  });

  it('never has more than the limit of mappers in flight', async () => {
    const gates = Array.from({ length: 12 }, () => gate());
    let inFlight = 0;
    let peak = 0;
    const pending = mapWithConcurrency(gates, 4, async (entry) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await entry.wait();
      inFlight--;
    });

    for (const entry of gates) {
      await settleMicrotasks();
      entry.release();
    }
    await pending;

    expect(peak).toBe(4);
  });

  it('starts limit mappers before any completes when there are enough items', async () => {
    const gates = Array.from({ length: 12 }, () => gate());
    let started = 0;
    const pending = mapWithConcurrency(gates, 4, async (entry) => {
      started++;
      await entry.wait();
    });

    await settleMicrotasks();
    const startedBeforeRelease = started;
    for (const entry of gates) entry.release();
    await pending;

    expect(startedBeforeRelease).toBe(4);
  });

  it('runs every item when the limit exceeds the item count', async () => {
    const seen: number[] = [];

    const results = await mapWithConcurrency([1, 2], 10, (item) => {
      seen.push(item);
      return Promise.resolve(item * 2);
    });

    expect(seen).toEqual([1, 2]);
    expect(results).toEqual([2, 4]);
  });

  it('passes each mapper the index of the item it receives', async () => {
    const items = ['x', 'y', 'z', 'w', 'v'];

    const pairs = await mapWithConcurrency(items, 2, (item, index) =>
      Promise.resolve({ item, index })
    );

    expect(pairs).toEqual(items.map((item, index) => ({ item, index })));
  });

  it('rejects the whole call with the error a mapper rejects with', async () => {
    const failure = new Error('mapper failed');

    const outcome = mapWithConcurrency([1, 2, 3], 2, (item) =>
      item === 2 ? Promise.reject(failure) : Promise.resolve(item)
    );

    await expect(outcome).rejects.toBe(failure);
  });

  it('resolves an empty list without running the mapper', async () => {
    let ran = false;

    const results = await mapWithConcurrency([], 4, () => {
      ran = true;
      return Promise.resolve(1);
    });

    expect(results).toEqual([]);
    expect(ran).toBe(false);
  });
});
