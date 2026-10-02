import type { JobShard } from './registry.js';

/**
 * The structural slice of a Durable Object namespace the wake nudge needs;
 * the real `DurableObjectNamespace` binding satisfies it without casts, and
 * node tests fake it without platform types.
 */
export interface JobDispatcherNamespace<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): { fetch(url: string, init?: { method: string }): Promise<unknown> };
}

/**
 * The lossy post-commit nudge, reached only through `createDispatcherWake`
 * (`./health-entry.ts`): a runtime boundary discharges the shards its
 * committed transactions collected, and the jobs-health auditor nudges when
 * it finds a stuck row. Never call it from a route, an op body, or inside a
 * domain transaction — an enqueue leaves its shard on the granting scope's
 * collector, and that boundary's discharge is what nudges the dispatcher.
 * Every failure is swallowed by design: the dispatcher's perpetual alarm is
 * the delivery guarantee, the wake only buys the ~10–50 ms
 * enqueue-to-first-attempt latency.
 */
export async function wakeJobDispatcher(
  namespace: JobDispatcherNamespace,
  shard: JobShard
): Promise<void> {
  try {
    await namespace
      .get(namespace.idFromName(shard))
      .fetch('https://job-dispatcher/wake', { method: 'POST' });
    // eslint-disable-next-line catch-swallow/no-silent-catch -- post-commit wake is lossy by design; the dispatcher's perpetual alarm is the delivery guarantee.
  } catch {
    // Lossy by design: the next dispatcher pulse recovers a lost wake.
  }
}
