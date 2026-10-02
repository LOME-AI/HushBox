import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDb,
  DB_CONNECT_TIMEOUT_MS,
  LOCAL_NEON_DEV_CONFIG,
  SERIAL_POOL_OVERLAP_ERROR_NAME,
} from '@hushbox/db';
import { openDispatcherDb } from '../jobs/index.js';
import { createRequestDb, REQUEST_STATEMENT_TIMEOUT_MS } from './factories.js';
import type { RequiredBindings } from './app-env.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`factories integration: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const bindings: RequiredBindings = {
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
};

/** drizzle wraps a failed statement, carrying the pool's rejection as its cause. */
const REFUSED_STATEMENT = { cause: { name: SERIAL_POOL_OVERLAP_ERROR_NAME } };

/** Postgres's own cancellation of a statement that outran `statement_timeout`. */
const TIMED_OUT_STATEMENT = { cause: { code: '57014' } };

/** One second past the bound: a sleep that only a cancellation cuts short. */
const OVERRUNNING_SLEEP = sql`select pg_sleep(${REQUEST_STATEMENT_TIMEOUT_MS / 1000 + 1})`;

/**
 * Above the round trip a cancellation takes to come back, below the second
 * by which the sleep overruns the bound, so a completed sleep cannot pass.
 */
const CANCELLATION_TOLERANCE_MS = 500;

/** Settles to the rejection, or to a marker when the promise resolves instead. */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return await pending.then(
    () => 'resolved',
    (error: unknown) => error
  );
}

describe.each([
  { arm: 'development', isDev: true },
  { arm: 'production', isDev: false },
])('the request database, $arm arm', ({ isDev }) => {
  beforeAll(async () => {
    // The production arm hands the driver no local settings, so it runs on
    // whatever the process last applied to the driver's module-wide config.
    // Building the development arm first applies the local proxy's, which is
    // what lets the production arm reach this stack at all.
    await createRequestDb(bindings, { isDev: true }).$client.end();
  });

  it('refuses a statement issued while another holds its one connection', async () => {
    const db = createRequestDb(bindings, { isDev });
    const started = performance.now();
    const [first, second] = await Promise.allSettled([
      db.execute(sql`select 1`),
      db.execute(sql`select 2`),
    ]);
    const elapsed = performance.now() - started;
    await db.$client.end();

    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: REFUSED_STATEMENT });
    expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS);
  });

  it('refuses a statement issued inside its own transaction at once', async () => {
    const db = createRequestDb(bindings, { isDev });
    const started = performance.now();
    const outcome = await db
      .transaction(async () => {
        await db.execute(sql`select 1`);
      })
      .then(
        () => 'resolved',
        (error: unknown) => error
      );
    const elapsed = performance.now() - started;
    await db.$client.end();

    expect(outcome).toMatchObject(REFUSED_STATEMENT);
    expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS);
  });

  it('cancels a statement that outruns the request bound, server-side', async () => {
    const db = createRequestDb(bindings, { isDev });
    // Connected first, so the timing below is the statement's alone.
    await db.execute(sql`select 1`);
    const started = performance.now();
    const outcome = await rejectionOf(db.execute(OVERRUNNING_SLEEP));
    const elapsed = performance.now() - started;
    await db.$client.end();

    expect(outcome).toMatchObject(TIMED_OUT_STATEMENT);
    expect(elapsed).toBeLessThan(REQUEST_STATEMENT_TIMEOUT_MS + CANCELLATION_TOLERANCE_MS);
  });

  it('answers the next statement on the same handle after a timeout cancelled one', async () => {
    const db = createRequestDb(bindings, { isDev });
    const cancelled = await rejectionOf(db.execute(OVERRUNNING_SLEEP));
    const after = await db.execute(sql`select 1 as n`);
    await db.$client.end();

    expect(cancelled).toMatchObject(TIMED_OUT_STATEMENT);
    expect(after.rows).toEqual([{ n: 1 }]);
  });
});

describe('the request bound beside the other planes', () => {
  // The Durable Objects, jobs and cron connect with the same role and URL, so
  // the bound reaches none of them only because no other creation site asks
  // for it.
  it('leaves a statement on the job dispatcher database to run past the request bound', async () => {
    const db = openDispatcherDb(bindings.DATABASE_URL, { isDev: true });
    const outcome = await rejectionOf(db.execute(OVERRUNNING_SLEEP));
    await db.$client.end();

    expect(outcome).toBe('resolved');
  });
});

describe('the request bound lifted for one transaction', () => {
  /** A transaction that lifts the bound, then sleeps past it. */
  async function sleepPastTheBoundUnbounded(
    db: ReturnType<typeof createRequestDb>
  ): Promise<unknown> {
    return rejectionOf(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = 0`);
        await tx.execute(OVERRUNNING_SLEEP);
      })
    );
  }

  it('runs a statement past the bound inside the transaction that lifted it', async () => {
    const db = createRequestDb(bindings, { isDev: true });
    const outcome = await sleepPastTheBoundUnbounded(db);
    await db.$client.end();

    expect(outcome).toBe('resolved');
  });

  it('bounds the next statement again once that transaction commits', async () => {
    const db = createRequestDb(bindings, { isDev: true });
    const lifted = await sleepPastTheBoundUnbounded(db);
    const after = await rejectionOf(db.execute(OVERRUNNING_SLEEP));
    await db.$client.end();

    expect(lifted).toBe('resolved');
    expect(after).toMatchObject(TIMED_OUT_STATEMENT);
  });
});

describe('a transaction over a login the server refuses', () => {
  /** Postgres's refusal of the password, which the pipelined login reports on `begin`. */
  const REFUSED_LOGIN = { cause: { code: '28P01' } };

  function refusedLoginUrl(): string {
    const refused = new URL(bindings.DATABASE_URL);
    refused.password = 'wrong-password';
    return refused.toString();
  }

  it('releases the connection when the transaction cannot log in', async () => {
    const db = createDb(refusedLoginUrl(), { neonDev: LOCAL_NEON_DEV_CONFIG });

    const outcome = await rejectionOf(db.transaction(async (tx) => tx.execute(sql`select 1`)));

    expect(outcome).toMatchObject(REFUSED_LOGIN);
    // Asserted before `end()`: a connection never released leaves `end()` waiting on it forever.
    expect(db.$client.totalCount).toBe(0);
    await expect(db.$client.end()).resolves.toBeUndefined();
  });

  it('fails the next request statement with the login error, never a serial overlap', async () => {
    const db = createRequestDb({ ...bindings, DATABASE_URL: refusedLoginUrl() }, { isDev: true });
    await rejectionOf(db.transaction(async (tx) => tx.execute(sql`select 1`)));

    const next = await rejectionOf(db.execute(sql`select 1`));

    expect(next).toMatchObject(REFUSED_LOGIN);
    await db.$client.end();
  });
});
