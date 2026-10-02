/**
 * The dispatcher's scheduling brain, as a plain module the node project
 * covers (thin-shell doctrine: the DO class only adapts the platform). The
 * executor — claim, execute, complete against Postgres — is injected by the
 * worker; this core owns the alarm discipline: arm-first, re-arm to the
 * exact next attempt, idle decay, and the wake-overwrite race.
 */
import { resolveDoName } from './do-identity.js';
import type { DoIdentityStore } from './do-identity.js';

/** What one dispatcher pass found, advising the next alarm. */
export type JobPassResult =
  | { readonly kind: 'due' }
  | { readonly kind: 'scheduled'; readonly delayMs: number }
  | { readonly kind: 'idle' };

/** The worker-bound pass executor (claim → execute → complete → advise). */
export interface JobPassExecutor {
  runPass(shard: string): Promise<JobPassResult>;
}

interface DispatcherScheduler {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

/** DO-storage key under which the dispatcher persists its own shard. */
export const SHARD_STORAGE_KEY = 'shard';

/** DO-storage key under which the idle ladder's anchor is persisted. */
export const LAST_WORK_STORAGE_KEY = 'lastWorkAt';

/**
 * Resolve the dispatcher's shard identity across reconstructions (the shared
 * `resolveDoName` mechanism the ConversationRoom also uses): a live
 * `idFromName` construction persists the shard, a nameless alarm revival
 * reads it back.
 */
export function resolveDispatcherShard(
  idName: string | undefined,
  store: DoIdentityStore
): Promise<string> {
  return resolveDoName(idName, store, {
    storageKey: SHARD_STORAGE_KEY,
    missingMessage:
      'JobDispatcher has no shard identity: id has no name and none was persisted — reach it via idFromName(shard) before its alarm fires',
  });
}

/**
 * Closed telemetry event set (the package carries no content-capable logging
 * surface); the worker binds each event to its typed Telemetry port.
 */
export interface DispatcherTelemetry {
  /** A whole pass rejected — per-job failures are the executor's business. */
  passFailed(fields: { shard: string }): void;
}

/**
 * Persistence for the idle ladder's anchor: the last moment work was signalled
 * to this shard. The rung is a function of stored state rather than of
 * instance memory, because the design expects the instance not to stay
 * resident — an idle dispatcher holds nothing across its decaying alarms, so a
 * rung kept in a field would restart at 60 s on every reconstruction.
 */
interface LastWorkStore {
  read(): Promise<number | undefined>;
  write(at: number): Promise<void>;
}

interface JobDispatcherCoreOptions {
  readonly shard: string;
  readonly executor: JobPassExecutor;
  readonly scheduler: DispatcherScheduler;
  readonly telemetry: DispatcherTelemetry;
  readonly now: () => number;
  readonly lastWork: LastWorkStore;
}

/**
 * The pulse armed before any fallible work: a crashed pass still leaves an
 * alarm, so the re-arm — not platform retries — is the delivery guarantee.
 */
export const ARM_FIRST_DELAY_MS = 30_000;

/**
 * Idle decay 60 s → 2 m → 5 m → 15 m → 30 m cap (lets Neon scale to zero).
 * Applies only when a pass found nothing pending or scheduled; any wake or
 * work resets the ladder, and decay never displaces an exact nextAttemptAt.
 */
export const IDLE_DECAY_LADDER_MS: readonly number[] = [60_000, 120_000, 300_000, 900_000];

const IDLE_DECAY_CAP_MS = 1_800_000;

/**
 * The rung for a given idleness. The ladder's own running sums are the
 * boundaries, so a shard idle for the sum of the first n delays sits on rung n
 * — the sequence the alarm chain walks when every pass finds nothing.
 */
function idleDelayFor(idleMs: number): number {
  let boundary = 0;
  for (const delay of IDLE_DECAY_LADDER_MS) {
    boundary += delay;
    if (idleMs < boundary) return delay;
  }
  return IDLE_DECAY_CAP_MS;
}

export class JobDispatcherCore {
  constructor(private readonly options: JobDispatcherCoreOptions) {}

  /** `wake()` = `setAlarm(min(getAlarm() ?? ∞, now))`, plus a ladder reset. */
  async wake(): Promise<void> {
    const { scheduler, now, lastWork } = this.options;
    const at = now();
    // A wake is work arriving: the nudge follows a committed jobs row. Moving
    // the anchor is what returns the ladder to its first rung.
    await lastWork.write(at);
    const current = await scheduler.getAlarm();
    if (current === null || current > at) {
      await scheduler.setAlarm(at);
    }
  }

  /**
   * One alarm tick. Never throws: per-job fallibility lives in the executor,
   * and a rejected pass leaves the arm-first pulse standing.
   */
  async onAlarm(): Promise<void> {
    const { scheduler, executor, telemetry, now, shard } = this.options;
    const armFirstAt = now() + ARM_FIRST_DELAY_MS;
    await scheduler.setAlarm(armFirstAt);
    let result: JobPassResult;
    try {
      result = await executor.runPass(shard);
    } catch {
      telemetry.passFailed({ shard });
      return;
    }
    const at = now();
    const target = await this.targetFor(result, at);
    // The wake-overwrite race: an alarm earlier than our own arm-first pulse
    // can only be a wake() that landed during the pass — `min` keeps it. An
    // alarm at the pulse is our own and is replaced by the computed target.
    const current = await scheduler.getAlarm();
    const wakeSet = current !== null && current < armFirstAt ? current : Number.POSITIVE_INFINITY;
    await scheduler.setAlarm(Math.min(target, wakeSet));
  }

  private async targetFor(result: JobPassResult, at: number): Promise<number> {
    const { lastWork } = this.options;
    switch (result.kind) {
      case 'due': {
        await lastWork.write(at);
        return at;
      }
      case 'scheduled': {
        await lastWork.write(at);
        return at + result.delayMs;
      }
      case 'idle': {
        // The empty-pass path writes nothing; it only reads the anchor. A
        // missing one means no work was ever signalled to this shard — the
        // alarm chain begins at a wake, which writes one — so it is as idle
        // as the ladder goes.
        const anchor = await lastWork.read();
        if (anchor === undefined) return at + IDLE_DECAY_CAP_MS;
        return at + idleDelayFor(at - anchor);
      }
    }
  }
}
