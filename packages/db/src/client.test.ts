import { describe, it, expect, vi } from 'vitest';
import { Client, Pool, neonConfig } from '@neondatabase/serverless';
import { PgTable } from 'drizzle-orm/pg-core';
import { expectExposes } from '@hushbox/shared/test-assertions';

import { createDb, DB_CONNECT_TIMEOUT_MS, LOCAL_NEON_DEV_CONFIG } from './client';
import * as schema from './schema/index';

const DATABASE_URL = 'postgresql://user:secret@localhost:4444/testdb';

describe('LOCAL_NEON_DEV_CONFIG', () => {
  it('formats the wsProxy address as host:port/v1 for string and number ports', () => {
    expect(LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', '4444')).toBe('localhost:4444/v1');
    expect(LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', 4444)).toBe('localhost:4444/v1');
  });
});

describe('createDb input validation', () => {
  it('throws when connectionString is empty', () => {
    expect(() => createDb('')).toThrow(/connectionString/);
  });

  it('throws when connectionString is not a URL', () => {
    expect(() => createDb('not a url at all')).toThrow(/postgres/);
  });

  it('throws when connectionString is not a postgres URL', () => {
    expect(() => createDb('mysql://user:pw@localhost:3306/db')).toThrow(/postgres/);
  });

  it('throws when injectLatencyMs is negative', () => {
    expect(() =>
      createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, injectLatencyMs: -1 })
    ).toThrow(/injectLatencyMs/);
  });

  it('throws when injectLatencyMs is not finite', () => {
    expect(() =>
      createDb(DATABASE_URL, {
        neonDev: LOCAL_NEON_DEV_CONFIG,
        injectLatencyMs: Number.POSITIVE_INFINITY,
      })
    ).toThrow(/injectLatencyMs/);
  });

  it('throws when injectLatencyMs is provided without neonDev', () => {
    expect(() => createDb(DATABASE_URL, { injectLatencyMs: 30 })).toThrow(/neonDev/);
  });
});

describe('createDb', () => {
  it('returns a drizzle database handle over a neon Pool', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    expect(db.$client).toBeInstanceOf(Pool);
    expectExposes(db, 'execute', 'transaction');
    await db.$client.end();
  });

  it('applies the neonDev settings to the driver config', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    expect(neonConfig.useSecureWebSocket).toBe(false);
    expect(neonConfig.pipelineTLS).toBe(false);
    expect(neonConfig.pipelineConnect).toBe('password');
    expect(neonConfig.wsProxy).toBe(LOCAL_NEON_DEV_CONFIG.wsProxy);
    await db.$client.end();
  });

  it('accepts injectLatencyMs of zero alongside neonDev', async () => {
    const db = createDb(DATABASE_URL, {
      neonDev: LOCAL_NEON_DEV_CONFIG,
      injectLatencyMs: 0,
    });
    expect(db.$client).toBeInstanceOf(Pool);
    await db.$client.end();
  });
});

describe('createDb pool errors', () => {
  it('absorbs the error the pool re-emits for a dropped idle client', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const dropped = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' }
    );
    expect(() => db.$client.emit('error', dropped, {})).not.toThrow();
    await db.$client.end();
  });

  it('absorbs an error a connected client raises while it is checked out', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const client = new Client(DATABASE_URL);
    db.$client.emit('connect', client);
    const dropped = new Error('Connection terminated unexpectedly');
    expect(() => client.emit('error', dropped)).not.toThrow();
    await db.$client.end();
  });
});

describe('connection acquisition deadline', () => {
  it('arms the pool with the derived connect deadline', async () => {
    const db = createDb(DATABASE_URL);
    const armed = db.$client.options.connectionTimeoutMillis;
    await db.$client.end();
    // An unarmed pool reads `undefined` here, which would match an undeclared
    // constant — so the deadline is asserted to be a real bound first.
    expect(DB_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(armed).toBe(DB_CONNECT_TIMEOUT_MS);
  });
});

describe('pool size', () => {
  it('holds one connection when no pool size is given', async () => {
    const db = createDb(DATABASE_URL);
    const max = db.$client.options.max;
    await db.$client.end();
    expect(max).toBe(1);
  });

  it('holds the requested number of connections when a pool size is given', async () => {
    const db = createDb(DATABASE_URL, { poolSize: 16 });
    const max = db.$client.options.max;
    await db.$client.end();
    expect(max).toBe(16);
  });

  it.each([0, -1, 2.5, Number.NaN])('throws when the pool size is %s', (poolSize) => {
    expect(() => createDb(DATABASE_URL, { poolSize })).toThrow(/poolSize/);
  });
});

describe('statement timeout', () => {
  it('sends the timeout as a startup options parameter rather than the bare config key', async () => {
    const db = createDb(DATABASE_URL, { statementTimeoutMs: 4000 });
    const config = db.$client.options;
    await db.$client.end();

    // pg's bare `statement_timeout` key is a startup parameter of its own, and
    // Neon's proxy drops it without error; only `options` reaches Postgres
    // there. The local proxy forwards both, so no integration test can tell
    // the two forms apart.
    expect(config.options).toBe('-c statement_timeout=4000');
    expect(Object.keys(config)).not.toContain('statement_timeout');
  });

  it.each([0, -1, 2.5, Number.NaN])('throws when the statement timeout is %s', (ms) => {
    expect(() => createDb(DATABASE_URL, { statementTimeoutMs: ms })).toThrow(/statementTimeoutMs/);
  });

  it('refuses a connection string whose own options would replace the timeout', () => {
    const carryingOptions = `${DATABASE_URL}?options=-c%20search_path%3Dpublic`;
    expect(() => createDb(carryingOptions, { statementTimeoutMs: 4000 })).toThrow(
      expect.objectContaining({ name: 'ConnectionStringOptionsError' })
    );
  });

  it('refuses a connection string whose own statement_timeout would override the timeout', () => {
    const carryingTimeout = `${DATABASE_URL}?statement_timeout=0`;
    expect(() => createDb(carryingTimeout, { statementTimeoutMs: 4000 })).toThrow(
      expect.objectContaining({ name: 'ConnectionStringOptionsError' })
    );
  });

  it('accepts a connection string carrying options when no timeout is asked for', async () => {
    const carryingOptions = `${DATABASE_URL}?options=-c%20search_path%3Dpublic`;
    const db = createDb(carryingOptions);
    expect(db.$client).toBeInstanceOf(Pool);
    await db.$client.end();
  });
});

describe('production driver configuration', () => {
  it('leaves the driver config untouched when no local settings are given', async () => {
    // `LOCAL_NEON_DEV_CONFIG` is dev/test only: production constructs the
    // client without it and keeps the driver's own defaults, which is what
    // confines cleartext-password pipelining to local development. Every
    // `NeonDevConfig` field gets a sentinel `createDb` would never write, so a
    // field it touches differs here rather than coinciding.
    const sentinelProxy = (host: string, port: string | number): string =>
      `${host}:${String(port)}/sentinel`;
    neonConfig.wsProxy = sentinelProxy;
    neonConfig.useSecureWebSocket = true;
    neonConfig.pipelineTLS = true;
    neonConfig.pipelineConnect = false;

    const db = createDb(DATABASE_URL);
    const applied = {
      wsProxy: neonConfig.wsProxy,
      useSecureWebSocket: neonConfig.useSecureWebSocket,
      pipelineTLS: neonConfig.pipelineTLS,
      pipelineConnect: neonConfig.pipelineConnect,
    };
    await db.$client.end();

    expect(applied).toEqual({
      wsProxy: sentinelProxy,
      useSecureWebSocket: true,
      pipelineTLS: true,
      pipelineConnect: false,
    });
  });
});

describe('createDb relational query API', () => {
  // Derived from the schema barrel, never enumerated: a table added to the
  // barrel tightens this test on its own.
  const tableKeys = (Object.entries(schema) as [string, unknown][])
    .filter(([, value]) => value instanceof PgTable)
    .map(([key]) => key)
    .toSorted((a, b) => a.localeCompare(b));

  it('exposes a relational query builder for every schema table', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    expect(tableKeys.length).toBeGreaterThan(0);
    expect(Object.keys(db.query).toSorted((a, b) => a.localeCompare(b))).toEqual(tableKeys);
    for (const key of tableKeys) {
      const builder = db.query[key as keyof typeof db.query];
      expectExposes(builder, 'findFirst', 'findMany');
    }
    await db.$client.end();
  });
});

describe('injected statement latency', () => {
  /**
   * A pooled client stand-in: the one member the latency patch replaces, beside the
   * listener registration every client the pool connects receives.
   */
  interface QueryingClient {
    on: (event: 'error', listener: (error: Error) => void) => unknown;
    query: (...args: unknown[]) => unknown;
  }

  function queryingClient(run: (...args: unknown[]) => unknown): QueryingClient {
    return { on: () => undefined, query: run };
  }

  it('delays every statement a pooled client runs and forwards its arguments', async () => {
    vi.useFakeTimers();
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, injectLatencyMs: 20 });
    const calls: unknown[][] = [];
    const client = queryingClient((...args) => {
      calls.push(args);
      return 'rows';
    });
    db.$client.emit('connect', client);

    const pending = client.query('select 1');
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBe('rows');
    expect(calls).toEqual([['select 1']]);

    vi.useRealTimers();
    await db.$client.end();
  });

  it('refuses a pooled client that exposes no query to delay', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, injectLatencyMs: 20 });
    const noQuery = { on: () => undefined } satisfies Pick<QueryingClient, 'on'>;
    expect(() => db.$client.emit('connect', noQuery)).toThrow(/query/);
    await db.$client.end();
  });
});
