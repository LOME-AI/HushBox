import { errors } from '@upstash/redis';
import { SERIAL_POOL_OVERLAP_ERROR_NAME } from '@hushbox/db';
import { isDomainError } from '../errors/index.js';
import { failureOfBoundedCall, rateLimitFailureOf } from '../rate-limit/consume.js';
import { BoundedRedisFailure } from '../resilience/bounded-redis.js';
import { DeadlineExpired } from '../resilience/policies.js';
import type { DomainError } from '../errors/index.js';
import type { RateLimitFailure } from '../rate-limit/consume.js';

/**
 * Which dependency an availability failure met. `unknown` is a failure whose
 * cause chain carries nothing this classifier recognises — a dependency it
 * has no reading for yet, or a refusal no dependency produced at all.
 */
export type Dependency = 'postgres' | 'redis' | 'unknown';

/**
 * How the dependency failed, each arm a different repair:
 * `acquire-timeout` — the pool's deadline on a waiter queued behind its full
 *   pool; a serial pool refuses that acquire instead, as `serial-overlap`;
 * `serial-overlap` — a serial pool refused an acquire while its connection was
 *   checked out: the caller overlapped its own statements, which is a code
 *   defect and not an outage;
 * `connect-timeout` — the pool's deadline on a connection still being opened;
 * `statement-timeout` — the server cancelled a statement at its own bound
 *   (SQLSTATE 57014);
 * `deadline` — a resilience policy's deadline;
 * `transport` — a call that failed without the store answering an error;
 * `server-error` — the store answered, and its answer was an error;
 * `unknown` — nothing in the chain names the arm.
 */
export type DependencyFailureArm =
  | 'acquire-timeout'
  | 'serial-overlap'
  | 'connect-timeout'
  | 'statement-timeout'
  | 'deadline'
  | 'transport'
  | 'server-error'
  | 'unknown';

/**
 * What an availability failure's cause chain says about it. `late` is whether
 * a deadline in the chain fired past the late-timer threshold, which says the
 * isolate's own event loop was stalled rather than the dependency slow.
 */
export interface DependencyFailure {
  readonly dependency: Dependency;
  readonly failure: DependencyFailureArm;
  readonly late: boolean;
}

/** What one link of a cause chain reveals; a link may reveal either half, both, or neither. */
interface Observation {
  readonly dependency?: Exclude<Dependency, 'unknown'>;
  readonly failure?: Exclude<DependencyFailureArm, 'unknown'>;
}

/**
 * pg-pool's two deadline errors carry no code, only these messages, so the
 * messages are the reading. They are the installed driver's literals, and the
 * classifier's tests produce each through the real pool, so a driver that
 * rewords one reddens a test rather than silently unnaming the arm.
 */
const POOL_ACQUIRE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const POOL_CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout';

const STATEMENT_TIMEOUT_SQLSTATE = '57014';

const SQLSTATE = /^[\dA-Z]{5}$/;

/**
 * The counting primitive stamps which of its four arms a failed check met; each
 * maps onto the arm here that names the same repair. An unreadable reply is the
 * store answering something other than a decision, so it is the store's error.
 */
const COUNTER_ARMS: Readonly<Record<RateLimitFailure, Exclude<DependencyFailureArm, 'unknown'>>> = {
  timeout: 'deadline',
  transport: 'transport',
  'store-error': 'server-error',
  unreadable: 'server-error',
};

/** Guards a chain that cites itself; real chains are a few links deep. */
const MAX_CHAIN_LENGTH = 16;

/**
 * The SQLSTATE a Postgres error answered by the server carries, or `undefined`
 * for any other error. The driver's error class is not reachable from here, so
 * its shape is the reading: a severity beside a five-character code.
 */
function sqlStateOf(error: Error): string | undefined {
  const code: unknown = Reflect.get(error, 'code');
  const severity: unknown = Reflect.get(error, 'severity');
  return typeof severity === 'string' && typeof code === 'string' && SQLSTATE.test(code)
    ? code
    : undefined;
}

function observeError(link: Error): Observation {
  if (link instanceof DeadlineExpired) return { failure: 'deadline' };
  if (link instanceof BoundedRedisFailure) {
    // It carries the policy's code and the store's error as its cause, the
    // shape the counter's own rule reads, so one Redis fault takes one arm
    // whichever path reported it.
    return { dependency: 'redis', failure: COUNTER_ARMS[failureOfBoundedCall(link)] };
  }
  if (link instanceof errors.UpstashError) return { dependency: 'redis', failure: 'server-error' };
  if (link.message === POOL_ACQUIRE_TIMEOUT_MESSAGE) {
    return { dependency: 'postgres', failure: 'acquire-timeout' };
  }
  if (link.message === POOL_CONNECT_TIMEOUT_MESSAGE) {
    return { dependency: 'postgres', failure: 'connect-timeout' };
  }
  if (link.name === SERIAL_POOL_OVERLAP_ERROR_NAME) {
    return { dependency: 'postgres', failure: 'serial-overlap' };
  }
  const sqlState = sqlStateOf(link);
  if (sqlState === undefined) return {};
  return {
    dependency: 'postgres',
    failure: sqlState === STATEMENT_TIMEOUT_SQLSTATE ? 'statement-timeout' : 'server-error',
  };
}

function observe(link: object): Observation {
  if (link instanceof Error) return observeError(link);
  if (!isDomainError(link)) return {};
  const stamped = rateLimitFailureOf(link);
  return stamped === undefined ? {} : { dependency: 'redis', failure: COUNTER_ARMS[stamped] };
}

function chainOf(error: DomainError): object[] {
  const chain: object[] = [];
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && chain.length < MAX_CHAIN_LENGTH) {
    chain.push(current);
    current = Reflect.get(current, 'cause');
  }
  return chain;
}

/**
 * Classifies an availability failure by walking its cause chain. The
 * dependency and the arm are each the first the chain reveals, outermost
 * first, because a wrapper that knows which store it called is closer to the
 * failure's meaning than the driver error it wraps; lateness is read from
 * wherever a deadline sits. It reads classes, codes and the driver's fixed
 * literals, and returns only closed-set values: no message and no cause text
 * leaves it.
 */
export function dependencyFailureOf(error: DomainError): DependencyFailure {
  let dependency: Dependency = 'unknown';
  let failure: DependencyFailureArm = 'unknown';
  let late = false;
  for (const link of chainOf(error)) {
    const observed = observe(link);
    if (dependency === 'unknown' && observed.dependency !== undefined) {
      dependency = observed.dependency;
    }
    if (failure === 'unknown' && observed.failure !== undefined) failure = observed.failure;
    if (link instanceof DeadlineExpired && link.late) late = true;
  }
  return { dependency, failure, late };
}
