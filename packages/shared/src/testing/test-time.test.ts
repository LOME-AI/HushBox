import { afterEach, describe, expect, it, vi } from 'vitest';

import * as instants from './test-instants.ts';
import * as testTime from './test-time.ts';
import { HOUR_MS, TEST_DAY_START, freezeClock, setClock } from './test-time.ts';

describe('freezeClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the wall clock to the given instant', () => {
    freezeClock(TEST_DAY_START);

    expect(Date.now()).toBe(TEST_DAY_START);
  });

  it('passes fake-timer options through to vitest', async () => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });

    // Only Date is faked, so a real timer still fires on its own.
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(Date.now()).toBe(TEST_DAY_START);
  });
});

describe('setClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves an already-frozen clock without reinstalling the timers', () => {
    freezeClock(TEST_DAY_START);

    setClock(TEST_DAY_START + HOUR_MS);

    expect(Date.now()).toBe(TEST_DAY_START + HOUR_MS);
  });
});

describe('republished instants', () => {
  it('serves every instant the pure module exports under this name too', () => {
    const republished = Object.fromEntries(
      Object.keys(instants).map((name) => [name, testTime[name as keyof typeof instants]])
    );

    expect(republished).toEqual({ ...instants });
  });
});
