import { ResultAsync } from '../result/index.js';
import { isDomainError, timeoutError, unavailableError } from '../errors/index.js';
import type { IPolicy, RetryPolicy, TimeoutPolicy } from 'cockatiel';
import type { DomainError } from '../errors/index.js';

/**
 * The policy factory is the single seam to cockatiel: nothing else may import
 * it (enforced by lint). Retry and timeout only — circuit breakers are banned
 * because breaker state in ephemeral isolate memory never accumulates
 * meaningful failure counts (a deliberate limit recorded in docs/DECISIONS.md).
 */

type Cockatiel = typeof import('cockatiel');

// Lazy import: cockatiel constructs AbortControllers at module scope, which
// workerd forbids at global eval — a static import breaks `wrangler dev` boot.
// Loaded on first policy execution (inside a request context) and memoized.
let cockatiel: Cockatiel | undefined;

async function loadCockatiel(): Promise<Cockatiel> {
  cockatiel ??= await import('cockatiel');
  return cockatiel;
}

export interface RetryOptions {
  /** Retry attempts after the initial one; the task runs at most maxRetries + 1 times. */
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  /** Upper bound on every backoff delay, jitter included. */
  readonly maxDelayMs: number;
}

interface TimeoutOptions {
  readonly timeoutMs: number;
}

export interface PolicyRunner {
  run<T>(task: (signal: AbortSignal) => Promise<T>): ResultAsync<T, DomainError>;
}

/**
 * Timer jitter on a healthy isolate is milliseconds; the event-loop freezes a
 * late timer exposes last seconds. A threshold between the two tells an isolate
 * stall from a slow dependency without mistaking jitter for either.
 */
export const LATE_TIMER_THRESHOLD_MS = 1000;

/**
 * A deadline that fired and found no answer: the cause every timeout this
 * factory produces carries, so a wrapper that keeps the cause chain keeps it.
 * `latenessMs` is how long after its scheduled instant the timer ran, and
 * `late` says the isolate was stalled rather than the dependency slow.
 */
export class DeadlineExpired extends Error {
  readonly latenessMs: number;
  readonly late: boolean;

  constructor(latenessMs: number, cause: unknown) {
    super('deadline expired', { cause });
    this.name = 'DeadlineExpired';
    this.latenessMs = latenessMs;
    this.late = latenessMs > LATE_TIMER_THRESHOLD_MS;
  }
}

function toDomainError(cause: unknown): DomainError {
  if (isDomainError(cause)) return cause;
  if (cause instanceof DeadlineExpired) return timeoutError('operation timed out', cause);
  return unavailableError('operation failed', cause);
}

/** A task run under one policy, handed the signal the run owns. */
type Execution = <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T>;

function runnerFor(build: (cockatielModule: Cockatiel) => Execution): PolicyRunner {
  let execution: Promise<Execution> | undefined;
  const buildExecution = async (): Promise<Execution> => build(await loadCockatiel());
  return {
    run: <T>(task: (signal: AbortSignal) => Promise<T>): ResultAsync<T, DomainError> => {
      execution ??= buildExecution();
      const pending = execution;
      // Every `execute` gets a signal minted here rather than cockatiel's
      // module-scope default: workerd binds an AbortSignal to the I/O context
      // that created it, and one shared across a Durable Object boundary
      // throws on read. Fresh and never aborted, so policy behaviour is
      // identical to the default it displaces.
      const contextSignal = new AbortController().signal;
      return ResultAsync.fromPromise(
        (async (): Promise<T> => {
          const execute = await pending;
          return await execute(task, contextSignal);
        })(),
        toDomainError
      );
    },
  };
}

function underPolicy(policy: IPolicy): Execution {
  return (task, signal) => policy.execute(({ signal: taskSignal }) => task(taskSignal), signal);
}

function nextMacrotask(): Promise<undefined> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * A deadline that looks before it rules. A timer that fires late, because the
 * isolate's event loop was blocked, runs ahead of the I/O that arrived during
 * the block, so an answer already in hand is invisible at the timer's callback
 * and at every microtask after it; one macrotask later it has run. Ruling after
 * that turn keeps the wall-time bound and stops a blocked isolate from blaming
 * a dependency that answered. It costs a genuine timeout one turn.
 */
function withinDeadline(cockatielModule: Cockatiel, options: TimeoutOptions): Execution {
  const deadline = buildTimeout(cockatielModule, options);
  return async <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> => {
    // The task's signal aborts when this deadline rules, not when its timer
    // fires: a task that gives up on its signal would otherwise have settled,
    // with its own abort, by the time the ruling looks for an answer.
    const cancellation = new AbortController();
    const answer = task(cancellation.signal);
    const outcome = ResultAsync.fromPromise(answer, (error: unknown) => error);
    // `execute` arms its timer as it is entered, so this is the timer's
    // scheduled instant less the bound.
    const armedAt = Date.now();
    try {
      return await deadline.execute(() => answer, signal);
    } catch (error: unknown) {
      if (!(error instanceof cockatielModule.TaskCancelledError)) throw error;
      const latenessMs = Date.now() - armedAt - options.timeoutMs;
      const settled = await Promise.race([outcome, nextMacrotask()]);
      if (settled === undefined) throw new DeadlineExpired(latenessMs, error);
      if (settled.isOk()) return settled.value;
      throw settled.error;
    } finally {
      cancellation.abort();
    }
  };
}

function buildRetry(cockatielModule: Cockatiel, options: RetryOptions): RetryPolicy {
  return cockatielModule.retry(cockatielModule.handleAll, {
    maxAttempts: options.maxRetries,
    backoff: new cockatielModule.ExponentialBackoff({
      initialDelay: options.initialDelayMs,
      maxDelay: options.maxDelayMs,
    }),
  });
}

function buildTimeout(cockatielModule: Cockatiel, options: TimeoutOptions): TimeoutPolicy {
  // Aggressive: this settles at the deadline even if the task never does. The
  // task never sees this policy's signal; its own aborts at the ruling.
  return cockatielModule.timeout(options.timeoutMs, cockatielModule.TimeoutStrategy.Aggressive);
}

export function retryPolicy(options: RetryOptions): PolicyRunner {
  return runnerFor((cockatielModule) => underPolicy(buildRetry(cockatielModule, options)));
}

export function timeoutPolicy(options: TimeoutOptions): PolicyRunner {
  return runnerFor((cockatielModule) => withinDeadline(cockatielModule, options));
}

/** Retry with a per-attempt timeout (timeout inside, retry outside). */
export function retryWithTimeoutPolicy(options: RetryOptions & TimeoutOptions): PolicyRunner {
  return runnerFor((cockatielModule) => {
    const retry = buildRetry(cockatielModule, options);
    const attempt = withinDeadline(cockatielModule, options);
    return (task, signal) =>
      retry.execute(({ signal: attemptSignal }) => attempt(task, attemptSignal), signal);
  });
}
