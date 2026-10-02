import type { jobs } from '@hushbox/db';
import type { z } from 'zod';
import type { DbWriter } from '../idempotency/transaction.js';
import type { ChunkedWork, ExecutionBudget } from './chunked.js';
import type { JobOutcome } from './outcome.js';

export type JobRow = typeof jobs.$inferSelect;
export type JobShard = JobRow['shard'];

/**
 * The mandatory idempotency declaration: how a handler's effect stays
 * exactly-once-equivalent across redelivery. `txn` = the handler commits its
 * effect and the terminal transition in one transaction via the bound
 * `JobExecution.completeWithinTx` capability — the executor sees the
 * `completed` outcome and skips its own terminal write, and a crash before
 * commit persists neither the effect nor the transition; `natural` = the
 * effect is naturally idempotent (e.g. a delete); `providerKey` = the
 * external call carries an idempotency key that is stable across every
 * attempt at the same effect, so the provider replays its original accepted
 * request (derive it from the payload — the day a digest summarizes — or from
 * the jobId where one row is the whole effect; a jobId-derived key is the
 * narrower choice, since it lets two rows for the same effect send twice);
 * `byEventId` = the effect dedupes on an external event id.
 */
const JOB_IDEMPOTENCY_CLASSES = ['txn', 'natural', 'providerKey', 'byEventId'] as const;
export type JobIdempotencyClass = (typeof JOB_IDEMPOTENCY_CLASSES)[number];

const JOB_SHARDS: ReadonlySet<JobShard> = new Set(['default', 'bulk']);

/** The shapes a registration may declare, checked like every other declaration. */
const JOB_SHAPES: ReadonlySet<string> = new Set(['oneShot', 'chunked']);

/** Versioned job-type names (`payment.verify.v1`) so payloads can evolve. */
const VERSIONED_TYPE_PATTERN = /^[a-z][a-zA-Z0-9.-]*\.v\d+$/;

/**
 * Crashed claims tolerated beyond the failure budget before the claim-time
 * dead-letter pass declares the job poison: completed attempts consume
 * `failures`, so `claims` only outruns `failures` when claimants die
 * mid-execution without writing a completion.
 */
const POISON_CLAIM_MARGIN = 3;

/**
 * The platform's 15-minute alarm wall caps one dispatcher pass, so a lease
 * longer than that is incoherent — the pass that holds it cannot outlive it —
 * and only delays crash recovery and poison detection.
 */
const MAX_JOB_LEASE_SECONDS = 900;

/**
 * What a row's reclaim deadline carries beyond its handler's execution budget:
 * the interval between the row being claimed and its handler starting, plus
 * the terminal write the budget kill makes. `claim.ts` stamps one
 * `claimedAt` for a whole batch in a single statement and the batch launches
 * under `Promise.all`, so that interval is one resolved query plus a
 * synchronous map — sub-second unless the isolate is pathologically blocked,
 * and five seconds is about an order of magnitude of headroom over it.
 * Choosing it costs two things: it is added to every job type's crash-recovery
 * window, and it lowers the largest declarable budget to
 * {@link MAX_JOB_LEASE_SECONDS} minus itself. Sizing it against the skew alone
 * is what makes it too large — a margin that can equal the smallest declared
 * budget consumes one whole, leaving that type's rows no execution time at all.
 */
export const RECLAIM_MARGIN_SECONDS = 5;

/** The ceiling on a declared budget, so the derived lease still fits the wall. */
const MAX_JOB_EXECUTION_SECONDS = MAX_JOB_LEASE_SECONDS - RECLAIM_MARGIN_SECONDS;

/**
 * The floor on a declared budget. A row's execution time is its lease less the
 * margin whenever the lease was stamped by a smaller registration than the one
 * now running it, so a budget at or below the margin leaves such a row nothing
 * to run in. Twice the margin is the smallest multiple that keeps at least half
 * of any declared budget available to every row that can carry it.
 */
const MIN_JOB_EXECUTION_SECONDS = RECLAIM_MARGIN_SECONDS * 2;

/**
 * The reclaim deadline a row carries, derived from the budget its handler may
 * run for. Derivation rather than a second declaration is what makes
 * `budget < lease` structural: no registration can order the two wrongly, so
 * no execution can outlive the lease that protects it.
 */
export function reclaimLeaseSeconds(maxExecutionSeconds: number): number {
  return maxExecutionSeconds + RECLAIM_MARGIN_SECONDS;
}

/** What an executing handler may see and do; every write it can reach is fenced. */
export interface JobExecution<Payload> {
  readonly jobId: string;
  readonly payload: Payload;
  /** The claim counter for this execution — part of the completion fence. */
  readonly claims: number;
  /**
   * The `txn`-class capability: writes this job's fenced `succeeded`
   * transition on the caller's open transaction, so the handler's effect and
   * the transition commit atomically. Returns the outcome the handler must
   * return; the executor then skips its own terminal write. A lost fence
   * throws, aborting the enclosing transaction — a zombie can never commit
   * its effect without the transition. Success is the only completion that
   * may carry an effect; `fail`/`dead`/`yield` outcomes are returned plainly
   * and written by the executor.
   */
  completeWithinTx(writer: DbWriter, result?: unknown): Promise<JobOutcome>;
}

export type JobHandler<Payload> = (execution: JobExecution<Payload>) => Promise<JobOutcome>;

/**
 * The executor's one way in, whichever shape a type declared. The budget is an
 * argument here and never a member of {@link JobExecution}: it reaches the
 * chunk loop, which is framework code, and no handler can read it.
 */
export type JobRun = (
  execution: JobExecution<unknown>,
  budget: ExecutionBudget
) => Promise<JobOutcome>;

interface JobRegistrationCommon<Schema extends z.ZodType> {
  readonly type: string;
  readonly schema: Schema;
  /** How long this type's work may run; the row's lease is derived from it. */
  readonly maxExecutionSeconds: number;
  readonly maxFailures: number;
  readonly idempotency: JobIdempotencyClass;
  /** Default routing for the type; an enqueue may still override per job. */
  readonly shard?: JobShard;
}

/** Work bounded by a constant: one invocation, no cursor, no checkpoint. */
export interface OneShotJobRegistration<
  Schema extends z.ZodType = z.ZodType,
> extends JobRegistrationCommon<Schema> {
  readonly kind: 'oneShot';
  readonly handler: JobHandler<z.infer<Schema>>;
}

/**
 * Work that scales with a caller-controlled input. The author supplies a cursor
 * and one unit of work through `chunkedWork`; the loop, the checkpoint and the
 * clock are the framework's. The work type carries a mark only that builder can
 * mint, so a hand-written loop cannot be written as an object literal — but a
 * builder result spread into one and overridden compiles, so unbounded work
 * between checkpoints is off the authored path rather than unreachable.
 */
export interface ChunkedJobRegistration<
  Schema extends z.ZodType = z.ZodType,
> extends JobRegistrationCommon<Schema> {
  readonly kind: 'chunked';
  /**
   * Every class but `txn`. That one is honoured by writing the terminal
   * transition through {@link JobExecution.completeWithinTx}, and a chunk is
   * handed its payload and cursor alone — so a chunked registration declaring
   * it could never keep the promise the class makes.
   */
  readonly idempotency: Exclude<JobIdempotencyClass, 'txn'>;
  readonly chunked: ChunkedWork<z.infer<Schema>>;
}

/**
 * The two shapes a job may take. The discriminant is what forces an author to
 * answer the question the shapes differ on: does this work scale with a
 * caller-controlled input?
 */
export type JobRegistration<Schema extends z.ZodType = z.ZodType> =
  | OneShotJobRegistration<Schema>
  | ChunkedJobRegistration<Schema>;

export interface RegisteredJob {
  readonly type: string;
  readonly schema: z.ZodType;
  readonly maxExecutionSeconds: number;
  readonly maxFailures: number;
  readonly maxClaims: number;
  readonly idempotency: JobIdempotencyClass;
  readonly shard: JobShard;
  readonly run: JobRun;
}

/** A registration as the enqueue path sees it: every declared budget, no work. */
export type EnqueueableJob = Omit<RegisteredJob, 'run'>;

/**
 * The registry surface `enqueueWithinTx` needs: registration metadata with no
 * runner. A job's work resolves live infrastructure of its own and reads little
 * more than its payload, so a caller able to reach it can run a job's real
 * effect from anywhere — including an admin preview, whose whole safety is
 * that its transaction rolls back. Withholding `run` here hides it from
 * the compiler only; {@link enqueueOnlyRegistry} is the value that has none to
 * find, and a holder handed the executable registry under this type is one
 * cast away from live work.
 */
export interface JobEnqueueRegistry {
  get(type: string): EnqueueableJob | undefined;
}

/** The executable surface: the dispatcher runs handlers off this. */
export interface JobRegistry extends JobEnqueueRegistry {
  register<Schema extends z.ZodType>(registration: JobRegistration<Schema>): void;
  get(type: string): RegisteredJob | undefined;
  types(): readonly string[];
}

/**
 * The dependency resolver a registration gets at an **enqueue-only**
 * composition site. `enqueueWithinTx` reads a registration's
 * schema/budget/shard and never its handler, so a resolver placed there is
 * never invoked: deferring construction defers a fail-fast that then never
 * runs, and an enqueue under broken configuration writes a row that cannot
 * succeed. The dependency is therefore built eagerly at such a site — the
 * config fault fails the enqueue — and handed over already resolved. Never
 * use it where the handler runs (the dispatcher's own registry): there, eager
 * construction is what makes one type's missing binding take down every type.
 */
export function enqueueOnlyDeps<Deps>(deps: Deps): () => Deps {
  return () => deps;
}

/**
 * The runtime half of {@link JobEnqueueRegistry}: a view whose registrations
 * carry no handler at all, so a caller that casts its way past the type finds
 * `undefined` rather than a live handler. Bind this — never the executable
 * registry — wherever a holder is meant to enqueue only; a type alone hides
 * the handler from the compiler while leaving the value in reach.
 */
export function enqueueOnlyRegistry(registry: JobRegistry): JobEnqueueRegistry {
  return {
    get: (type: string): EnqueueableJob | undefined => {
      const registration = registry.get(type);
      if (registration === undefined) {
        return undefined;
      }
      // Built field by field rather than spread-minus-runner: a field added
      // to `RegisteredJob` then fails to compile here rather than silently
      // riding along, and no spread can carry the runner back in.
      return {
        type: registration.type,
        schema: registration.schema,
        maxExecutionSeconds: registration.maxExecutionSeconds,
        maxFailures: registration.maxFailures,
        maxClaims: registration.maxClaims,
        idempotency: registration.idempotency,
        shard: registration.shard,
      };
    },
  };
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * Registration is rejected if incomplete — the checks run at runtime (not
 * just compile time) because a wrong declaration here silently corrupts
 * every row of that type: a job enqueued under a bad registration would
 * carry the wrong lease, budget, or shard for its entire life.
 */
function isChunkedWork(value: unknown): value is ChunkedWork<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { runChunks?: unknown }).runChunks === 'function'
  );
}

function assertExecutableDeclaration(registration: JobRegistration): void {
  const { type, schema, kind } = registration;
  if (typeof type !== 'string' || !VERSIONED_TYPE_PATTERN.test(type)) {
    throw new Error(
      `job registry: type must be a versioned name like "payment.verify.v1", got ${JSON.stringify(type)}`
    );
  }
  if (!isZodSchema(schema)) {
    throw new Error(`job registry: ${type} declares no payload schema`);
  }
  if (!JOB_SHAPES.has(kind)) {
    throw new Error(`job registry: ${type} kind must be one of oneShot|chunked`);
  }
  if (registration.kind === 'oneShot') {
    if (typeof registration.handler !== 'function') {
      throw new TypeError(`job registry: ${type} declares no handler`);
    }
    return;
  }
  if (!isChunkedWork(registration.chunked)) {
    throw new TypeError(`job registry: ${type} declares no chunked work`);
  }
  // Read as a string because the type has already excluded it: this is the
  // arm a cast or a JavaScript caller reaches, which is the same reason every
  // other declaration on this path is checked at runtime and not only at
  // compile time.
  const declaredClass: string = registration.idempotency;
  if (declaredClass === 'txn') {
    throw new Error(`job registry: ${type} chunked work cannot declare the txn class`);
  }
}

/**
 * The runner the executor calls. A one-shot handler is invoked with its
 * execution and nothing else; chunked work is handed the payload and the
 * budget its loop paces itself against.
 */
function runnerFor(registration: JobRegistration): JobRun {
  if (registration.kind === 'chunked') {
    const { chunked } = registration;
    return (execution, budget) => chunked.runChunks(execution.payload, budget);
  }
  // The execution path parses the payload with this registration's own schema
  // before invoking the handler, which is what makes the widened payload safe.
  const { handler } = registration;
  return (execution) => handler(execution);
}

function assertBudgetDeclaration(registration: JobRegistration): void {
  const { type, maxExecutionSeconds, maxFailures, idempotency, shard } = registration;
  if (
    !Number.isInteger(maxExecutionSeconds) ||
    maxExecutionSeconds < MIN_JOB_EXECUTION_SECONDS ||
    maxExecutionSeconds > MAX_JOB_EXECUTION_SECONDS
  ) {
    throw new Error(
      `job registry: ${type} maxExecutionSeconds must be an integer between ${String(MIN_JOB_EXECUTION_SECONDS)} and ${String(MAX_JOB_EXECUTION_SECONDS)}`
    );
  }
  if (!Number.isInteger(maxFailures) || maxFailures < 1) {
    throw new Error(`job registry: ${type} maxFailures must be a positive integer`);
  }
  if (!JOB_IDEMPOTENCY_CLASSES.includes(idempotency)) {
    throw new Error(
      `job registry: ${type} idempotency must be one of txn|natural|providerKey|byEventId`
    );
  }
  if (shard !== undefined && !JOB_SHARDS.has(shard)) {
    throw new Error(`job registry: ${type} shard must be one of default|bulk`);
  }
}

function assertCompleteRegistration(registration: JobRegistration): void {
  assertExecutableDeclaration(registration);
  assertBudgetDeclaration(registration);
}

export function createJobRegistry(): JobRegistry {
  const registrations = new Map<string, RegisteredJob>();
  return {
    register(registration) {
      assertCompleteRegistration(registration);
      if (registrations.has(registration.type)) {
        throw new Error(`job registry: ${registration.type} is already registered`);
      }
      registrations.set(registration.type, {
        type: registration.type,
        schema: registration.schema,
        maxExecutionSeconds: registration.maxExecutionSeconds,
        maxFailures: registration.maxFailures,
        maxClaims: registration.maxFailures + POISON_CLAIM_MARGIN,
        idempotency: registration.idempotency,
        shard: registration.shard ?? 'default',
        run: runnerFor(registration),
      });
    },
    get(type) {
      return registrations.get(type);
    },
    types() {
      return [...registrations.keys()];
    },
  };
}
