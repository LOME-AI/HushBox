import { createDispatcherWake } from './health-entry.js';
import type { JobShard } from './registry.js';
import type { JobDispatcherNamespace } from './wake.js';

/**
 * The job-wake capability: the shards whose dispatcher must be nudged once the
 * caller's transaction commits, carried by the transaction handle itself.
 */

const JOB_WAKES: unique symbol = Symbol('jobWakes');

/** The in-memory shard set a scope collects into; nothing here is durable. */
export interface JobWakeCollector {
  readonly collect: (shard: JobShard) => void;
  readonly shards: () => readonly JobShard[];
}

/** A handle carrying the capability. Only {@link grantJobWakes} produces one. */
export type JobWakeCapable<T> = T & { readonly [JOB_WAKES]: JobWakeCollector };

export function createJobWakeCollector(): JobWakeCollector {
  const shards = new Set<JobShard>();
  return {
    collect: (shard) => {
      shards.add(shard);
    },
    shards: () => [...shards],
  };
}

/**
 * Attaches the collector to the handle rather than wrapping it: a Drizzle
 * transaction is a class instance whose methods live on its prototype, so a
 * spread or a copy would strip the query builders the handle exists for.
 */
export function grantJobWakes<T extends object>(
  handle: T,
  collector: JobWakeCollector
): JobWakeCapable<T> {
  return Object.assign(handle, { [JOB_WAKES]: collector });
}

/** A handle seen by a read that has not been told whether the brand is there. */
interface MaybeJobWakeCapable {
  readonly [JOB_WAKES]?: JobWakeCollector;
}

/**
 * Reads back the collector a handle carries, tolerating one no scope granted:
 * a transaction opener runs under boundaries that mint the capability and under
 * call sites that never had one, and only the ungranted case is distinguishable
 * at runtime.
 *
 * The assertion is the tolerance. The brand key is private to this module and
 * {@link grantJobWakes} is its only writer, so a value present at it is a
 * collector by construction, while the parameter has to stay a plain handle the
 * compiler has not proven capable.
 */
export function jobWakesOf(handle: object): JobWakeCollector | undefined {
  return (handle as MaybeJobWakeCapable)[JOB_WAKES];
}

/** Records a shard whose dispatcher the granting scope must nudge after commit. */
export function collectJobWake(handle: JobWakeCapable<object>, shard: JobShard): void {
  handle[JOB_WAKES].collect(shard);
}

/**
 * Copies the source collector's shards into the target, deduplicated by the
 * target's own set, so a shard merged twice still wakes its dispatcher once.
 * Copies rather than drains: a merged child keeps what it collected.
 *
 * Module-local, because {@link runWithJobWakes} is the whole merge-on-commit
 * protocol and the only step that needs it — a second caller would be a second
 * spelling of that protocol.
 */
function mergeJobWakes(source: JobWakeCollector, target: JobWakeCollector): void {
  for (const shard of source.shards()) {
    target.collect(shard);
  }
}

/**
 * The merge-on-commit protocol every transaction opener runs, written once: the
 * body gets its OWN collector, and its shards reach the handle's collector only
 * after the body has returned normally. A body that throws merges nothing, so a
 * rolled-back transaction can wake no dispatcher.
 *
 * The handle is a plain object rather than a granted one because an opener runs
 * both under a boundary that minted a collector and under call sites that never
 * had one; an ungranted handle discards what the body collected, which is the
 * same tolerance {@link jobWakesOf} exists for.
 */
export async function runWithJobWakes<T>(
  handle: object,
  body: (collected: JobWakeCollector) => Promise<T>
): Promise<T> {
  const collected = createJobWakeCollector();
  const result = await body(collected);
  const parent = jobWakesOf(handle);
  if (parent !== undefined) mergeJobWakes(collected, parent);
  return result;
}

/** The structural env slice a discharging scope needs. */
interface JobWakeEnv {
  readonly JOB_DISPATCHER?: JobDispatcherNamespace;
}

/**
 * Fires the collected wakes after the granting transaction has committed. The
 * nudge is promptness, never delivery: an absent binding is a no-op and every
 * failure is swallowed, because the dispatcher's perpetual alarm is what
 * guarantees the job runs.
 */
export async function dischargeJobWakes(
  env: JobWakeEnv,
  collector: JobWakeCollector
): Promise<void> {
  const wake = createDispatcherWake(env);
  for (const shard of collector.shards()) {
    await wake(shard);
  }
}
