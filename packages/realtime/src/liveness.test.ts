import { describe, expect, it, vi } from 'vitest';
import { createCachedLiveness } from './liveness.js';
import type { LivenessOutcome, LivenessProbe } from './liveness.js';

const FRESHNESS_MS = 5000;
const STALE_AFTER_MS = 30_000;
const LAST_KNOWN_GOOD_MS = 60_000;

interface HarnessConfig {
  cacheOutcome?: LivenessOutcome | null;
  cacheFails?: boolean;
  sourceOutcome?: LivenessOutcome;
  sourceFails?: boolean;
  writeFails?: boolean;
}

interface Harness {
  decide(key?: string): Promise<string>;
  reconfigure(config: HarnessConfig): void;
  setNow(value: number): void;
  /** Suspends every probe until `release()`, standing in for a slow backend. */
  hold(): void;
  release(): void;
  size(): number;
  readonly cacheReads: number;
  readonly sourceReads: number;
  readonly writes: LivenessOutcome[];
}

function harness(initial: HarnessConfig = {}): Harness {
  let config = initial;
  let now = 1000;
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const counters = { cacheReads: 0, sourceReads: 0 };
  const writes: LivenessOutcome[] = [];
  const cached = createCachedLiveness({
    freshnessMs: FRESHNESS_MS,
    staleAfterMs: STALE_AFTER_MS,
    lastKnownGoodMs: LAST_KNOWN_GOOD_MS,
    now: () => now,
  });
  const probe: LivenessProbe = {
    readCache: async () => {
      counters.cacheReads += 1;
      if (gate !== null) await gate;
      if (config.cacheFails === true) throw new Error('cache down');
      return config.cacheOutcome ?? null;
    },
    readSource: async () => {
      counters.sourceReads += 1;
      if (gate !== null) await gate;
      if (config.sourceFails === true) throw new Error('source down');
      return config.sourceOutcome ?? 'live';
    },
    writeCache: (outcome) => {
      if (config.writeFails === true) return Promise.reject(new Error('write down'));
      writes.push(outcome);
      return Promise.resolve();
    },
  };
  return {
    decide: (key = 'k1') => cached.decide(key, probe),
    reconfigure: (next) => {
      config = next;
    },
    setNow: (value) => {
      now = value;
    },
    hold: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    release: () => {
      const open = openGate;
      gate = null;
      openGate = null;
      open?.();
    },
    size: () => cached.size(),
    get cacheReads() {
      return counters.cacheReads;
    },
    get sourceReads() {
      return counters.sourceReads;
    },
    writes,
  };
}

describe('cache hits', () => {
  it('answers live from the cache without a source read', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await expect(h.decide()).resolves.toBe('live');
    expect(h.sourceReads).toBe(0);
  });

  it('answers dead from the cache', async () => {
    await expect(harness({ cacheOutcome: 'dead' }).decide()).resolves.toBe('dead');
  });
});

describe('cache misses', () => {
  it('rechecks the source and writes the recheck back', async () => {
    const h = harness({ cacheOutcome: null, sourceOutcome: 'live' });
    await expect(h.decide()).resolves.toBe('live');
    expect(h.sourceReads).toBe(1);
    expect(h.writes).toEqual(['live']);
  });

  it('still answers when the write-back fails', async () => {
    const h = harness({ cacheOutcome: null, sourceOutcome: 'live', writeFails: true });
    await expect(h.decide()).resolves.toBe('live');
  });

  it('pauses when the source read fails with no prior decision', async () => {
    await expect(harness({ cacheOutcome: null, sourceFails: true }).decide()).resolves.toBe(
      'pause'
    );
  });
});

describe('memoization', () => {
  it('reuses a fresh decision without re-reading the cache', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.setNow(2000);
    await h.decide();
    expect(h.cacheReads).toBe(1);
  });

  it('re-reads the cache once the decision goes stale', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.setNow(7000);
    await h.decide();
    expect(h.cacheReads).toBe(2);
  });

  it('keeps keys isolated', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide('a');
    await h.decide('b');
    expect(h.cacheReads).toBe(2);
  });
});

describe('stale-while-revalidate', () => {
  it('serves the memoized outcome without waiting on a slow probe', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.setNow(7000);
    h.hold();
    await expect(h.decide()).resolves.toBe('live');
    h.release();
  });

  it('refreshes behind the served outcome', async () => {
    const h = harness({ cacheOutcome: null, sourceOutcome: 'live' });
    await h.decide();
    h.setNow(7000);
    h.reconfigure({ cacheOutcome: null, sourceOutcome: 'dead' });
    await expect(h.decide()).resolves.toBe('live');
    await vi.waitFor(() => {
      expect(h.writes).toEqual(['live', 'dead']);
    });
    await expect(h.decide()).resolves.toBe('dead');
  });

  it('waits for the probe once the decision is past the staleness window', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.setNow(1000 + STALE_AFTER_MS);
    h.reconfigure({ cacheOutcome: 'dead' });
    await expect(h.decide()).resolves.toBe('dead');
  });

  it('measures the last-known-good window from the last verified decision', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.reconfigure({ cacheFails: true });
    h.setNow(1000 + FRESHNESS_MS + 1);
    await expect(h.decide()).resolves.toBe('live');
    h.setNow(1000 + LAST_KNOWN_GOOD_MS);
    await expect(h.decide()).resolves.toBe('pause');
  });
});

describe('single-flight probes', () => {
  it('issues one backend read for concurrent decides of one key', async () => {
    const h = harness({ cacheOutcome: null, sourceOutcome: 'live' });
    h.hold();
    const decisions = Promise.all([h.decide(), h.decide(), h.decide()]);
    h.release();
    await expect(decisions).resolves.toEqual(['live', 'live', 'live']);
    expect(h.cacheReads).toBe(1);
    expect(h.sourceReads).toBe(1);
  });

  it('keeps concurrent decides of distinct keys on their own probes', async () => {
    const h = harness({ cacheOutcome: null, sourceOutcome: 'live' });
    h.hold();
    const decisions = Promise.all([h.decide('a'), h.decide('b')]);
    h.release();
    await decisions;
    expect(h.sourceReads).toBe(2);
  });

  it('probes again once an earlier probe has settled', async () => {
    const h = harness({ cacheOutcome: null, sourceOutcome: 'live' });
    await h.decide();
    h.setNow(1000 + STALE_AFTER_MS);
    await h.decide();
    expect(h.sourceReads).toBe(2);
  });
});

describe('memo eviction', () => {
  it('drops an entry past the last-known-good window when a decision is written', async () => {
    const h = harness({ cacheOutcome: 'dead' });
    await h.decide('a');
    expect(h.size()).toBe(1);
    h.setNow(1000 + LAST_KNOWN_GOOD_MS);
    await h.decide('b');
    expect(h.size()).toBe(1);
  });

  it('keeps an entry that is still inside the last-known-good window', async () => {
    const h = harness({ cacheOutcome: 'dead' });
    await h.decide('a');
    h.setNow(1000 + LAST_KNOWN_GOOD_MS - 1);
    await h.decide('b');
    expect(h.size()).toBe(2);
  });

  it('stays bounded as many distinct keys arrive', async () => {
    const h = harness({ cacheOutcome: 'live' });
    const arrivals = Array.from({ length: 50 }, (_unused, index) => index);
    for (const index of arrivals) {
      h.setNow(1000 + index * LAST_KNOWN_GOOD_MS);
      await h.decide(`k${String(index)}`);
    }
    expect(h.size()).toBe(1);
  });

  it('keeps a dead decision sticky while its entry is inside the window', async () => {
    const h = harness({ cacheOutcome: 'dead' });
    await h.decide('a');
    h.setNow(1000 + LAST_KNOWN_GOOD_MS - 1);
    await h.decide('b');
    h.reconfigure({ cacheFails: true });
    await expect(h.decide('a')).resolves.toBe('dead');
  });

  it('re-answers a swept dead key from the source', async () => {
    const h = harness({ cacheOutcome: 'dead' });
    await h.decide('a');
    h.setNow(1000 + LAST_KNOWN_GOOD_MS);
    await h.decide('b');
    await expect(h.decide('a')).resolves.toBe('dead');
  });

  it('pauses a swept dead key when the backend is unreachable', async () => {
    const h = harness({ cacheOutcome: 'dead' });
    await h.decide('a');
    h.setNow(1000 + LAST_KNOWN_GOOD_MS);
    await h.decide('b');
    h.reconfigure({ cacheFails: true });
    await expect(h.decide('a')).resolves.toBe('pause');
  });
});

describe('fail-closed last-known-good window', () => {
  it('keeps a recently verified live target when the cache is down', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.reconfigure({ cacheFails: true });
    h.setNow(10_000);
    await expect(h.decide()).resolves.toBe('live');
  });

  it('pauses a live target verified beyond the window when the cache is down', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.reconfigure({ cacheFails: true });
    h.setNow(70_000);
    await expect(h.decide()).resolves.toBe('pause');
  });

  it('pauses when the cache is down and the key was never verified', async () => {
    await expect(harness({ cacheFails: true }).decide()).resolves.toBe('pause');
  });

  it('never un-dead-s on failure regardless of the window', async () => {
    const h = harness({ cacheOutcome: 'dead' });
    await h.decide();
    h.reconfigure({ cacheFails: true });
    h.setNow(70_000);
    await expect(h.decide()).resolves.toBe('dead');
  });

  it('applies the window when the source fails on a miss', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.reconfigure({ cacheOutcome: null, sourceFails: true });
    h.setNow(10_000);
    await expect(h.decide()).resolves.toBe('live');
  });
});
