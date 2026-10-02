import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import {
  createDb,
  DB_CONNECT_TIMEOUT_MS,
  LOCAL_NEON_DEV_CONFIG,
  SERIAL_POOL_OVERLAP_ERROR_NAME,
  type Database,
} from './client';
import { userFactory, walletFactory } from './factories/index';
import { users } from './schema/users';
import { wallets } from './schema/wallets';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function firstRow(result: { rows: Record<string, unknown>[] }): Record<string, unknown> {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Query returned no rows');
  }
  return row;
}

describe('createDb integration (local neon-proxy)', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('returns a native v7 uuid from SELECT uuidv7()', async () => {
    const row = firstRow(await db.execute(sql`select uuidv7() as id`));
    expect(row['id']).toMatch(UUID_V7_PATTERN);
  });

  it('reaches a PostgreSQL 18 server', async () => {
    const row = firstRow(await db.execute(sql`select current_setting('server_version_num') as v`));
    const versionNumber = Number(row['v']);
    expect(versionNumber).toBeGreaterThanOrEqual(180_000);
    expect(versionNumber).toBeLessThan(190_000);
  });

  it('runs a multi-statement interactive transaction with read-your-writes', async () => {
    await db.execute(sql`create temp table client_txn_probe (id int primary key)`);
    const insideCount = await db.transaction(async (tx) => {
      await tx.execute(sql`insert into client_txn_probe values (1)`);
      await tx.execute(sql`insert into client_txn_probe values (2)`);
      const row = firstRow(await tx.execute(sql`select count(*)::int as n from client_txn_probe`));
      return row['n'];
    });
    expect(insideCount).toBe(2);
    const after = firstRow(await db.execute(sql`select count(*)::int as n from client_txn_probe`));
    expect(after['n']).toBe(2);
  });

  it('rolls back every statement when the transaction callback throws', async () => {
    await db.execute(sql`create temp table client_rollback_probe (id int primary key)`);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into client_rollback_probe values (1)`);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');
    const after = firstRow(
      await db.execute(sql`select count(*)::int as n from client_rollback_probe`)
    );
    expect(after['n']).toBe(0);
  });

  it('resolves a declared relation through the relational query API', async () => {
    let walletTypes: string[] | undefined;
    await expect(
      db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values(userFactory.build()).returning();
        if (user === undefined) {
          throw new Error('user insert returned no row');
        }
        await tx.insert(wallets).values(walletFactory.build({ userId: user.id }));
        const found = await tx.query.users.findFirst({
          where: eq(users.id, user.id),
          with: { wallets: true },
        });
        walletTypes = found?.wallets.map((wallet) => wallet.type);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');
    expect(walletTypes).toEqual(['purchased']);
  });
});

describe('createDb latency injection (local neon-proxy)', () => {
  // begin + three selects + commit = five statements on one checked-out client.
  async function timeFiveStatementTxn(client: Database): Promise<number> {
    const start = performance.now();
    await client.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      await tx.execute(sql`select 2`);
      await tx.execute(sql`select 3`);
    });
    return performance.now() - start;
  }

  it('inflates a multi-statement transaction wall time by the per-statement delay', async () => {
    const plain = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const slow = createDb(DATABASE_URL, {
      neonDev: LOCAL_NEON_DEV_CONFIG,
      injectLatencyMs: 30,
    });
    try {
      // Warm both pools so connection setup is excluded from the timings.
      await plain.execute(sql`select 1`);
      await slow.execute(sql`select 1`);

      const baseline = Math.min(
        await timeFiveStatementTxn(plain),
        await timeFiveStatementTxn(plain),
        await timeFiveStatementTxn(plain)
      );
      const inflated = await timeFiveStatementTxn(slow);

      // 5 statements x 30 ms = 150 ms nominal; generous margins, no exact timing.
      expect(inflated).toBeGreaterThanOrEqual(120);
      expect(inflated).toBeGreaterThanOrEqual(baseline + 80);
    } finally {
      await plain.$client.end();
      await slow.$client.end();
    }
  });
});

describe('createDb connection acquisition deadline (local neon-proxy)', () => {
  it('clears a queued waiter from the pool when the deadline passes', async () => {
    const bounded = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const pool = bounded.$client;
    // `max: 1`, so the one checked-out client leaves the next acquire with
    // nothing to take: it queues, which is the wait this deadline bounds.
    const held = await pool.connect();
    const queued = pool.connect();
    expect(pool.waitingCount).toBe(1);

    await expect(queued).rejects.toThrow(/timeout exceeded when trying to connect/);
    // The pool's own state, not just the caller's: a waiter that merely gave up
    // on its caller would still be sitting in this queue.
    expect(pool.waitingCount).toBe(0);

    held.release();
    const after = await pool.connect();
    after.release();
    await pool.end();
  }, 12_000);
});

describe('createDb serial mode (local neon-proxy)', () => {
  const DEFECT = { name: SERIAL_POOL_OVERLAP_ERROR_NAME };

  /** Settles to the rejection, or to a marker when the promise resolves instead. */
  async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
    try {
      await pending;
      return 'resolved';
    } catch (error) {
      return error;
    }
  }

  it('a second acquire on a serial pool fails at once with the named defect', async () => {
    const serial = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, serial: true });
    const pool = serial.$client;
    const held = await pool.connect();
    const started = performance.now();
    const second = await rejectionOf(pool.connect());
    const elapsed = performance.now() - started;
    held.release();
    await pool.end();

    expect(second).toMatchObject(DEFECT);
    // A queued waiter is only ever rejected by the acquisition deadline, so
    // settling inside it is what "at once" means here.
    expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS);
  });

  it('a second acquire beside one still waiting for the idle connection fails at once', async () => {
    const serial = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, serial: true });
    const pool = serial.$client;
    // An idle connection is handed over on a later tick, so the first acquire
    // waits in the pool's queue while the second arrives.
    await serial.execute(sql`select 1`);
    const first = pool.connect();
    const started = performance.now();
    const second = await rejectionOf(pool.connect());
    const elapsed = performance.now() - started;
    const acquired = await first;
    acquired.release();
    await pool.end();

    expect(second).toMatchObject(DEFECT);
    expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS);
  });

  it('hands a refused callback acquire a release it can call', async () => {
    const serial = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, serial: true });
    const pool = serial.$client;
    const held = await pool.connect();
    // pg's callback form hands `done` on every outcome, and a caller may call it
    // whatever the outcome; one that throws would fail this promise.
    const refusal = await new Promise<unknown>((resolve) => {
      pool.connect((error, _client, done) => {
        done();
        resolve(error);
      });
    });
    held.release();
    await pool.end();

    expect(refusal).toMatchObject(DEFECT);
  });

  it('a serial pool serves statements issued one after another', async () => {
    const serial = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, serial: true });
    try {
      const first = firstRow(await serial.execute(sql`select 1 as n`));
      const second = firstRow(await serial.execute(sql`select 2 as n`));
      expect([first['n'], second['n']]).toEqual([1, 2]);
    } finally {
      await serial.$client.end();
    }
  });

  // The shape of a `db` call made inside a `db.transaction` callback. The
  // transaction form itself is proven on the request database in apps/api:
  // this suite loads drizzle's copy of the driver apart from the one this
  // module builds its pool from, so drizzle's `instanceof Pool` check fails
  // here and a transaction never holds the connection.
  it('a statement issued while the serial pool connection is checked out fails at once with the same defect', async () => {
    const serial = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, serial: true });
    const pool = serial.$client;
    const held = await pool.connect();
    const started = performance.now();
    const outcome = await rejectionOf(serial.execute(sql`select 1`));
    const elapsed = performance.now() - started;
    held.release();
    await pool.end();

    // drizzle wraps a failed statement, carrying the pool's rejection as its cause.
    expect(outcome).toMatchObject({ cause: DEFECT });
    expect(elapsed).toBeLessThan(DB_CONNECT_TIMEOUT_MS);
  });
});

describe('createDb pool size (local neon-proxy)', () => {
  // A second backend only opens while the first connection is still checked
  // out, so two distinct pids mean the two queries were in flight together.
  async function backendPidsOfTwoConcurrentQueries(client: Database): Promise<Set<unknown>> {
    const results = await Promise.all([
      client.execute(sql`select pg_backend_pid() as pid`),
      client.execute(sql`select pg_backend_pid() as pid`),
    ]);
    return new Set(results.map((result) => firstRow(result)['pid']));
  }

  it('runs two queries concurrently on distinct connections when given a pool size', async () => {
    const pooled = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, poolSize: 16 });
    try {
      const backendPids = await backendPidsOfTwoConcurrentQueries(pooled);
      expect(backendPids.size).toBe(2);
    } finally {
      await pooled.$client.end();
    }
  });
});

describe('createDb when the server ends an idle connection (local neon-proxy)', () => {
  it('drops the dead connection and serves the next statement on a new one', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const killer = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    try {
      const pid = firstRow(await db.$client.query('select pg_backend_pid() as pid'))['pid'];
      await killer.$client.query('select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() => {
        expect(db.$client.totalCount).toBe(0);
      });
      await expect(db.$client.query('select 1')).resolves.toBeDefined();
    } finally {
      await db.$client.end();
      await killer.$client.end();
    }
  });
});

describe('createDb when the server ends a checked-out connection (local neon-proxy)', () => {
  it('rejects the statement in flight to its caller', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const killer = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const client = await db.$client.connect();
    try {
      await client.query('begin');
      const pid = firstRow(await client.query('select pg_backend_pid() as pid'))['pid'];
      const ended = new Promise((resolve) => {
        client.once('end', resolve);
      });
      // Handled before the kill, so a rejection that lands first is never unhandled.
      const rejected = expect(client.query('select pg_sleep(30)')).rejects.toThrow(/terminat/);
      await killer.$client.query('select pg_terminate_backend($1)', [pid]);
      await rejected;
      // Released only once the connection has ended: a release on the rejection alone
      // returns the client to the pool, whose idle listener then receives the drop.
      await ended;
    } finally {
      client.release();
      await db.$client.end();
      await killer.$client.end();
    }
  });
});
