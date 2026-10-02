import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { LAST_WORK_STORAGE_KEY, SHARD_STORAGE_KEY } from '../job-dispatcher-core.js';
import { jobDispatcherControl } from './test-worker.js';

function dispatcherStub(shard: string): DurableObjectStub {
  return env.JOB_DISPATCHER.get(env.JOB_DISPATCHER.idFromName(shard));
}

/**
 * Schedules a far-future alarm directly so `runDurableObjectAlarm` can force
 * it deterministically — a wake()'s immediate alarm self-fires and would
 * race the forced run.
 */
async function armFuture(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.setAlarm(Date.now() + 600_000);
  });
}

async function getAlarm(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Force one alarm tick (the pass finds nothing, so the executor advises
 * `idle`) and report the window the re-arm must fall inside: the core reads
 * its clock between `before` and `after`, so a re-arm of `delay` lands in
 * `[before + delay, after + delay]` exactly.
 */
async function fireIdlePass(
  stub: DurableObjectStub
): Promise<{ before: number; after: number; alarm: number }> {
  const before = Date.now();
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const after = Date.now();
  const alarm = await getAlarm(stub);
  expect(alarm).not.toBeNull();
  return { before, after, alarm: alarm! };
}

/**
 * Seed the idle anchor in DO storage, then force one empty pass. The rung the
 * core re-arms to is derived from that stored anchor, so the re-arm reads a
 * ladder position out of storage rather than one held by whichever instance
 * armed the previous alarm.
 */
async function fireIdlePassAfterIdle(
  stub: DurableObjectStub,
  idleMs: number
): Promise<{ before: number; after: number; alarm: number }> {
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.put(LAST_WORK_STORAGE_KEY, Date.now() - idleMs)
  );
  return fireIdlePass(stub);
}

/** Poll the alarm until it settles inside the window, which is what defeats
 * both reads that are not the one wanted: a stale alarm above the window (the
 * rung the shard sat on before) and the transient arm-first pulse below it. */
async function waitForAlarmWithin(
  stub: DurableObjectStub,
  low: number,
  high: number,
  what: string
): Promise<number> {
  const start = Date.now();
  for (;;) {
    const alarm = await getAlarm(stub);
    if (alarm !== null && alarm >= low && alarm <= high) return alarm;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  jobDispatcherControl.passes.length = 0;
  jobDispatcherControl.results.length = 0;
  jobDispatcherControl.failNextPass = false;
});

describe('JobDispatcher under workerd', () => {
  it('arms the pulse before the pass, so a failing pass still leaves an alarm', async () => {
    const stub = dispatcherStub('arm-first');
    jobDispatcherControl.failNextPass = true;
    await armFuture(stub);
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const alarm = await getAlarm(stub);
    expect(jobDispatcherControl.passes).toEqual(['arm-first']);
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(before + 25_000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('drives a real pass from the platform alarm and re-arms to the advised delay', async () => {
    const stub = dispatcherStub('scheduled');
    jobDispatcherControl.results.push({ kind: 'scheduled', delayMs: 5000 });
    await armFuture(stub);
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const alarm = await getAlarm(stub);
    expect(jobDispatcherControl.passes).toEqual(['scheduled']);
    expect(alarm!).toBeGreaterThanOrEqual(before + 4000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('schedules an immediate alarm on a wake fetch, which fires a pass on its own without waiting for an alarm rung', async () => {
    // The node tests only fake the dispatcher namespace; here a real cross-DO
    // wake fetch under workerd must drive a real pass. `until`'s budget is the
    // discriminating bound — well below the ladder's shortest rung, so a pass
    // seen inside it came from the nudge rather than from an alarm. Nudge
    // latency itself is deliberately not asserted: at this resolution that
    // reading is the host's load, not this code's behaviour.
    const stub = dispatcherStub('woken');
    const response = await stub.fetch('https://job-dispatcher/wake', { method: 'POST' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ woken: true });
    await until(() => jobDispatcherControl.passes.includes('woken'), 'the woken pass');
    // The pass found nothing (idle): the perpetual alarm is re-armed, never cleared.
    const alarm = await getAlarm(stub);
    expect(alarm).not.toBeNull();
  });

  it('answers anything but a wake with NOT_FOUND', async () => {
    const stub = dispatcherStub('routes');
    const response = await stub.fetch('https://job-dispatcher/other', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('persists its shard to storage on a live wake', async () => {
    const stub = dispatcherStub('persists');
    await stub.fetch('https://job-dispatcher/wake', { method: 'POST' });
    await until(() => jobDispatcherControl.passes.includes('persists'), 'the woken pass');
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>(SHARD_STORAGE_KEY)
    );
    expect(stored).toBe('persists');
  });

  it('runs its pass when the platform revives it for an alarm without a named id', async () => {
    // The platform reconstructs an alarm-firing DO from the stored id alone,
    // which carries no name (`idFromString` reproduces that nameless id). The
    // shard, persisted by an earlier live wake, must survive that revival —
    // pre-seeded here directly so the alarm is the object's first construction.
    const named = env.JOB_DISPATCHER.idFromName('revived');
    const nameless = env.JOB_DISPATCHER.get(env.JOB_DISPATCHER.idFromString(named.toString()));
    await runInDurableObject(nameless, (_instance, state) =>
      state.storage.put(SHARD_STORAGE_KEY, 'revived')
    );
    await armFuture(nameless);
    jobDispatcherControl.passes.length = 0;

    expect(await runDurableObjectAlarm(nameless)).toBe(true);
    expect(jobDispatcherControl.passes).toEqual(['revived']);
  });

  it('builds again after a first initialization failed, instead of replaying it', async () => {
    // A DO revived with no name and nothing persisted cannot resolve its shard,
    // so its very first build rejects. Persisting the shard makes the next
    // request buildable: the instance must retry rather than stay poisoned
    // until the platform happens to evict it.
    const named = env.JOB_DISPATCHER.idFromName('rebuilds-after-failure');
    const nameless = env.JOB_DISPATCHER.get(env.JOB_DISPATCHER.idFromString(named.toString()));

    await expect(nameless.fetch('https://job-dispatcher/wake', { method: 'POST' })).rejects.toThrow(
      /no shard identity/
    );

    await runInDurableObject(nameless, (_instance, state) =>
      state.storage.put(SHARD_STORAGE_KEY, 'rebuilds-after-failure')
    );

    const response = await nameless.fetch('https://job-dispatcher/wake', { method: 'POST' });
    expect(response.status).toBe(200);
  });

  it('derives each idle rung from the anchor it reads back out of DO storage', async () => {
    const stub = dispatcherStub('idle-ladder');
    await armFuture(stub);
    // Each idleness is the running sum of the delays preceding its rung — the
    // boundary at which a shard steps onto that rung — and the two cap entries
    // pin the cap holding once the ladder is exhausted. The order is
    // deliberately not ascending: a rung counted off empty passes rather than
    // derived from the stored anchor can only ever climb, so it reproduces an
    // ascending expectation exactly and is caught by nothing but a sequence
    // that descends.
    const rungs = [
      { idleMs: 480_000, delay: 900_000 },
      { idleMs: 0, delay: 60_000 },
      { idleMs: 1_380_000, delay: 1_800_000 },
      { idleMs: 60_000, delay: 120_000 },
      { idleMs: 3_600_000, delay: 1_800_000 },
      { idleMs: 180_000, delay: 300_000 },
    ];
    for (const rung of rungs) {
      const { before, after, alarm } = await fireIdlePassAfterIdle(stub, rung.idleMs);
      expect(alarm).toBeGreaterThanOrEqual(before + rung.delay);
      expect(alarm).toBeLessThanOrEqual(after + rung.delay);
    }
  });

  it('returns the idle ladder to the first rung when a wake lands mid-decay', async () => {
    const stub = dispatcherStub('idle-reset');
    await armFuture(stub);
    // Deep enough on the ladder that a shard whose anchor the wake failed to
    // move stays at the 30m cap, which is outside the window read below.
    const stepped = await fireIdlePassAfterIdle(stub, 1_380_000);
    expect(stepped.alarm).toBeGreaterThanOrEqual(stepped.before + 1_800_000);

    // A wake schedules an immediate, self-firing pass; that pass's idle re-arm
    // is the reading. The window sits above the transient 30s arm-first pulse
    // and far below the cap, so only a ladder returned to its first rung lands
    // inside it.
    const before = Date.now();
    const response = await stub.fetch('https://job-dispatcher/wake', { method: 'POST' });
    expect(response.status).toBe(200);
    const alarm = await waitForAlarmWithin(
      stub,
      before + 45_000,
      before + 120_000,
      'the post-wake idle re-arm'
    );
    expect(alarm).toBeGreaterThanOrEqual(before + 60_000);
  });
});
