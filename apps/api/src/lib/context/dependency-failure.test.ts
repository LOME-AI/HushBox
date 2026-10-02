import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { TEST_DAY_START, freezeClock, setClock } from '@hushbox/shared/test-time';
import { timeoutError, unavailableError } from '../errors/index.js';
import { createBoundedRedis } from '../resilience/bounded-redis.js';
import { DeadlineExpired, LATE_TIMER_THRESHOLD_MS, timeoutPolicy } from '../resilience/policies.js';
import { dependencyFailureOf } from './dependency-failure.js';
import type { Socket } from 'node:net';
import type { DomainError } from '../errors/index.js';
import type { RateLimitFailure } from '../rate-limit/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required: run through a package test script.');
}

/** Far below the pool's own deadline, far above a local acquire. */
const SHORT_POOL_DEADLINE_MS = 50;

/** Well under a test's patience, far enough above a microtask to be a real wait. */
const SHORT_REDIS_DEADLINE_MS = 40;

const REDIS_CREDENTIALS = { url: 'http://localhost:8079', token: 'token' } as const;

/** The rejection a promise settles with, having asserted that it rejected. */
async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  const outcome = await work.then(
    () => ({ settled: 'resolved' as const }),
    (error: unknown) => ({ settled: 'rejected' as const, error })
  );
  if (outcome.settled === 'resolved') throw new Error('expected the work to reject');
  return outcome.error;
}

/**
 * A pool from the real factory with its one connection checked out, so the
 * next acquire queues. The deadline is lowered on the pool's own options, which
 * the installed pg-pool reads at every acquire: what fires is its own timer and
 * its own error.
 */
async function poolWithItsConnectionHeld(): Promise<{
  readonly db: ReturnType<typeof createDb>;
  readonly release: () => Promise<void>;
}> {
  const db = createDb(DATABASE_URL ?? '', { neonDev: LOCAL_NEON_DEV_CONFIG });
  db.$client.options.connectionTimeoutMillis = SHORT_POOL_DEADLINE_MS;
  const held = await db.$client.connect();
  return {
    db,
    release: async (): Promise<void> => {
      held.release();
      await db.$client.end();
    },
  };
}

/**
 * A serial pool from the real factory with its one connection checked out, so
 * the next acquire overlaps it and the pool refuses that acquire itself.
 */
async function serialPoolWithItsConnectionHeld(): Promise<{
  readonly db: ReturnType<typeof createDb>;
  readonly release: () => Promise<void>;
}> {
  const db = createDb(DATABASE_URL ?? '', { neonDev: LOCAL_NEON_DEV_CONFIG, serial: true });
  const held = await db.$client.connect();
  return {
    db,
    release: async (): Promise<void> => {
      held.release();
      await db.$client.end();
    },
  };
}

/**
 * A TCP endpoint that accepts a connection and never says anything, so a
 * client connecting through it is still connecting when its deadline fires.
 */
async function silentEndpoint(): Promise<{ readonly port: number; readonly stop: () => void }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port bound');
  return {
    port: address.port,
    stop: (): void => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/**
 * The endpoint's own shape: the client pipelines, so it posts an array of
 * commands and reads back one entry per command. Each stub is annotated as the
 * global it stands in for, so the compiler checks it against that contract.
 */
function neverAnsweringFetch(): typeof globalThis.fetch {
  return () => new Promise<Response>(() => {});
}

function refusingFetch(): typeof globalThis.fetch {
  return () => Promise.resolve(Response.json({ error: 'store refused' }, { status: 500 }));
}

/** An answer the client cannot read as one entry per command, which it throws on itself. */
function unreadableFetch(): typeof globalThis.fetch {
  return () => Promise.resolve(Response.json({}, { status: 200 }));
}

/** A bounded command's failure, wrapped as every Redis operation wraps it. */
async function boundedRedisFailure(): Promise<DomainError> {
  const redis = createBoundedRedis(REDIS_CREDENTIALS, SHORT_REDIS_DEADLINE_MS);
  return unavailableError('redis get failed', await rejectionOf(redis.get('key')));
}

/** The counting primitive's failure, carrying the arm it stamps. */
function stampedCounterFailure(
  failure: RateLimitFailure
): DomainError & { readonly rateLimitFailure: RateLimitFailure } {
  return { ...unavailableError('rate limit consume failed'), rateLimitFailure: failure };
}

/** A timeout whose timer fired `latenessMs` after its scheduled instant. */
async function timeoutFiredLateBy(latenessMs: number): Promise<DomainError> {
  freezeClock(TEST_DAY_START, { toFake: ['Date'] });
  const result = await timeoutPolicy({ timeoutMs: 10 }).run(() => {
    queueMicrotask(() => {
      setClock(TEST_DAY_START + 10 + latenessMs);
    });
    return new Promise<never>(() => {});
  });
  return result._unsafeUnwrapErr();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('dependencyFailureOf: Postgres, through the installed driver', () => {
  it("names the pool's queued-acquire deadline a postgres acquire timeout", async () => {
    const { db, release } = await poolWithItsConnectionHeld();
    const cause = await rejectionOf(db.$client.connect());
    await release();

    expect(dependencyFailureOf(unavailableError('read failed', cause))).toEqual({
      dependency: 'postgres',
      failure: 'acquire-timeout',
      late: false,
    });
  });

  it("names the queued-acquire deadline under drizzle's own wrapping", async () => {
    const { db, release } = await poolWithItsConnectionHeld();
    const cause = await rejectionOf(db.execute(sql`select 1`));
    await release();

    expect(cause).toHaveProperty('query', 'select 1');
    expect(dependencyFailureOf(unavailableError('read failed', cause))).toMatchObject({
      dependency: 'postgres',
      failure: 'acquire-timeout',
    });
  });

  it("names the pool's connecting deadline a postgres connect timeout", async () => {
    const endpoint = await silentEndpoint();
    const db = createDb(`postgres://nobody:nothing@127.0.0.1:${String(endpoint.port)}/none`, {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    db.$client.options.connectionTimeoutMillis = SHORT_POOL_DEADLINE_MS;

    const cause = await rejectionOf(db.$client.connect());
    endpoint.stop();
    await db.$client.end();

    expect(dependencyFailureOf(unavailableError('read failed', cause))).toEqual({
      dependency: 'postgres',
      failure: 'connect-timeout',
      late: false,
    });
  });

  it('names a statement its timeout cancelled a postgres statement timeout', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const cause = await rejectionOf(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = 10`);
        await tx.execute(sql`select pg_sleep(1)`);
      })
    );
    await db.$client.end();

    expect(dependencyFailureOf(unavailableError('read failed', cause))).toMatchObject({
      dependency: 'postgres',
      failure: 'statement-timeout',
    });
  });

  it('names an acquire a serial pool refused while its connection was checked out a postgres serial overlap', async () => {
    const { db, release } = await serialPoolWithItsConnectionHeld();
    const cause = await rejectionOf(db.$client.connect());
    await release();

    expect(dependencyFailureOf(unavailableError('read failed', cause))).toEqual({
      dependency: 'postgres',
      failure: 'serial-overlap',
      late: false,
    });
  });

  it("names the serial overlap under drizzle's own wrapping", async () => {
    const { db, release } = await serialPoolWithItsConnectionHeld();
    const cause = await rejectionOf(db.execute(sql`select 1`));
    await release();

    expect(cause).toHaveProperty('query', 'select 1');
    expect(dependencyFailureOf(unavailableError('read failed', cause))).toMatchObject({
      dependency: 'postgres',
      failure: 'serial-overlap',
    });
  });

  it('names any other error the server answered with a postgres server error', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const cause = await rejectionOf(db.execute(sql`select 1 / 0`));
    await db.$client.end();

    expect(dependencyFailureOf(unavailableError('read failed', cause))).toMatchObject({
      dependency: 'postgres',
      failure: 'server-error',
    });
  });
});

describe('dependencyFailureOf: Redis, through the bounded client', () => {
  it('names a command that outlived its deadline a redis deadline', async () => {
    vi.stubGlobal('fetch', neverAnsweringFetch());

    expect(dependencyFailureOf(await boundedRedisFailure())).toEqual({
      dependency: 'redis',
      failure: 'deadline',
      late: false,
    });
  });

  it('names a command the store answered with an error a redis server error', async () => {
    vi.stubGlobal('fetch', refusingFetch());

    expect(dependencyFailureOf(await boundedRedisFailure())).toMatchObject({
      dependency: 'redis',
      failure: 'server-error',
    });
  });

  it('names a command that failed other than by the store answering an error a redis transport failure', async () => {
    vi.stubGlobal('fetch', unreadableFetch());

    expect(dependencyFailureOf(await boundedRedisFailure())).toMatchObject({
      dependency: 'redis',
      failure: 'transport',
    });
  });

  it.each([
    ['timeout', 'deadline'],
    ['transport', 'transport'],
    ['store-error', 'server-error'],
    ['unreadable', 'server-error'],
  ] as const)(
    "reads the rate-limit counter's %s arm as a redis %s",
    (stamped: RateLimitFailure, arm: string) => {
      expect(dependencyFailureOf(stampedCounterFailure(stamped))).toEqual({
        dependency: 'redis',
        failure: arm,
        late: false,
      });
    }
  );
});

describe('dependencyFailureOf: lateness', () => {
  it('says the isolate was late when the deadline behind the failure fired past the threshold', async () => {
    const error = await timeoutFiredLateBy(LATE_TIMER_THRESHOLD_MS + 1);

    expect(dependencyFailureOf(error)).toEqual({
      dependency: 'unknown',
      failure: 'deadline',
      late: true,
    });
  });

  it('says the isolate was on time when the deadline fired within the threshold', async () => {
    const error = await timeoutFiredLateBy(LATE_TIMER_THRESHOLD_MS);

    expect(dependencyFailureOf(error).late).toBe(false);
  });

  it('reads the lateness from under the dependency that named the failure', () => {
    const lateDeadline = timeoutError('operation timed out', new DeadlineExpired(1500, null));
    const counter = { ...stampedCounterFailure('timeout'), cause: lateDeadline };

    expect(dependencyFailureOf(counter)).toEqual({
      dependency: 'redis',
      failure: 'deadline',
      late: true,
    });
  });
});

describe('dependencyFailureOf: what it cannot name', () => {
  it("does not read an error that only carries the bounded client's class name as redis", () => {
    const impostor = Object.assign(new Error('not the bounded client'), {
      name: 'BoundedRedisFailure',
      code: 'timeout',
    });

    expect(dependencyFailureOf(unavailableError('read failed', impostor))).toEqual({
      dependency: 'unknown',
      failure: 'unknown',
      late: false,
    });
  });

  it('names neither dependency nor arm for a cause it does not recognise', () => {
    expect(dependencyFailureOf(unavailableError('caller ip unresolved'))).toEqual({
      dependency: 'unknown',
      failure: 'unknown',
      late: false,
    });
  });

  it('stops at a cause that is not an object', () => {
    expect(dependencyFailureOf(unavailableError('read failed', 'socket closed'))).toEqual({
      dependency: 'unknown',
      failure: 'unknown',
      late: false,
    });
  });

  it('ends its walk on a chain that cites itself', () => {
    const looped = new Error('looped');
    looped.cause = looped;

    expect(dependencyFailureOf(unavailableError('read failed', looped))).toEqual({
      dependency: 'unknown',
      failure: 'unknown',
      late: false,
    });
  });
});
