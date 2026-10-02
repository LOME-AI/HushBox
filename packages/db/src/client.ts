import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema/index';
import type { PoolClient } from '@neondatabase/serverless';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';

/**
 * Runtime-agnostic by construction: this module never imports the node-only
 * `ws` package. The driver falls back to the global WebSocket constructor,
 * which exists in both Node >= 22 and workerd — the same code path therefore
 * runs in node-environment tests, the production Worker, and Durable Objects.
 */

export interface NeonDevConfig {
  wsProxy: (host: string, port: string | number) => string;
  useSecureWebSocket: boolean;
  pipelineTLS: boolean;
  pipelineConnect: false | 'password';
}

/**
 * Settings for the local neon-proxy (wsproxy container). Dev/test only.
 *
 * `pipelineConnect: 'password'` is the driver's own default and the path
 * production takes. It needs the server to ask for a cleartext password, which
 * is why the compose Postgres sets `POSTGRES_HOST_AUTH_METHOD: password`; the
 * two move together, and `scripts/lib/stack/postgres-auth-method.ts` records
 * the pairing's failure mode and keeps an existing cluster asking for
 * `password`. What this setting buys on its own is the connect round trip it
 * folds into the first statement. The larger cost is in the
 * driver's SASL path, which computes the SCRAM proof as one awaited WebCrypto
 * HMAC per PBKDF2 iteration on the JavaScript thread and serialises concurrent
 * connects behind it; the cleartext ask is what keeps that path out of the
 * local connect. Sending the credential in the clear costs nothing here: it is
 * a committed constant (`packages/shared/src/env/env.config.ts`), and this
 * config's `useSecureWebSocket: false` leaves the transport no encryption to
 * weaken.
 */
export const LOCAL_NEON_DEV_CONFIG: NeonDevConfig = {
  wsProxy: (host: string, port: string | number) => `${host}:${String(port)}/v1`,
  useSecureWebSocket: false,
  pipelineTLS: false,
  pipelineConnect: 'password',
};

/**
 * The deadline on acquiring a pooled connection, armed on the pool itself.
 *
 * The pool's own option rather than a wrapping timeout policy, and the two are
 * not interchangeable: a policy settles the CALLER at its deadline and leaves
 * the waiter sitting in pg-pool's pending queue holding its place, while
 * `connectionTimeoutMillis` removes a queued waiter from that queue and
 * destroys a client still connecting. With `max: 1` a second concurrent
 * acquire queues, so the queued arm is the ordinary case here, except on a
 * serial pool: it refuses that acquire, which leaves it only the connecting arm.
 *
 * Derived 2026-09-19 by measuring acquisition against the local neon-proxy on
 * a 24-core host held at full CPU saturation: at 12-way concurrency p50 8.8 ms
 * and p99 36 ms; at 48-way, p50 35 ms, p99 1081 ms and a worst acquire of
 * 1082 ms. The bound clears that distribution with margin, and it also has to
 * clear a case the local stack cannot produce at all — a Neon compute resuming
 * from scale-to-zero, for which no local percentile exists — which is what
 * holds the figure above the scale the measurement alone would set. Re-measure
 * to change it; the derivation is what survives an infrastructure change, not
 * the number.
 */
export const DB_CONNECT_TIMEOUT_MS = 5000;

interface DbOptions {
  /** Local neon-proxy settings. Omit in production. */
  neonDev?: NeonDevConfig;
  /**
   * Fixed delay (ms) added before every statement. Local-only test/dev knob:
   * the local wsproxy's ~0 ms round trips hide transaction-shape regressions
   * (e.g. settlement lock-hold growth) that production's per-statement latency
   * exposes. Requires neonDev. Deliberately not an env-registry entry — the
   * backend env module lands in a later task; until then this is programmatic
   * only.
   */
  injectLatencyMs?: number;
  /** Connections the pool may hold at once. Omitted, the pool holds one. */
  poolSize?: number;
  /**
   * Refuse an acquire while the connection is checked out, instead of queueing
   * it. For a handle whose work must run one statement at a time: an overlap
   * then fails where it is written, not at the acquisition deadline.
   */
  serial?: boolean;
  /**
   * Server-side bound on every statement this pool's sessions run, in ms.
   * Omitted, statements run unbounded. A transaction can lift it for itself
   * with `SET LOCAL statement_timeout`.
   */
  statementTimeoutMs?: number;
}

export type Database = NeonDatabase<typeof schema> & { $client: Pool };

class ConnectionStringOptionsError extends Error {
  override name = 'ConnectionStringOptionsError';

  constructor(parameter: string) {
    super(
      `createDb: the connectionString carries a \`${parameter}\` parameter, which would ` +
        'override the statement timeout statementTimeoutMs sets. Remove it from the URL.'
    );
  }
}

/**
 * Query parameters that would defeat the timeout. The driver assigns the
 * parsed URL over the config object, so a URL's `options` silently discards the
 * timeout rather than joining it. A URL's `statement_timeout` goes out as a
 * startup parameter of its own, which Postgres applies over the `-c` in
 * `options`; Neon's proxy drops that key, so it would unbound local sessions
 * only, and local gates would pass statements production cancels.
 */
const TIMEOUT_OVERRIDING_PARAMETERS = ['options', 'statement_timeout'];

function validate(connectionString: string, options: DbOptions): void {
  if (connectionString.trim() === '') {
    throw new Error('createDb: connectionString is required');
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('createDb: connectionString must be a postgres:// or postgresql:// URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('createDb: connectionString must be a postgres:// or postgresql:// URL');
  }
  if (options.injectLatencyMs !== undefined) {
    if (!Number.isFinite(options.injectLatencyMs) || options.injectLatencyMs < 0) {
      throw new Error('createDb: injectLatencyMs must be a finite number >= 0');
    }
    if (options.neonDev === undefined) {
      throw new Error(
        'createDb: injectLatencyMs is a local-driver-only option and requires neonDev'
      );
    }
  }
  validatePoolSize(options.poolSize);
  validateStatementTimeout(url, options.statementTimeoutMs);
}

function validatePoolSize(poolSize: number | undefined): void {
  if (poolSize !== undefined && (!Number.isInteger(poolSize) || poolSize < 1)) {
    throw new Error('createDb: poolSize must be an integer >= 1');
  }
}

function validateStatementTimeout(url: URL, statementTimeoutMs: number | undefined): void {
  if (statementTimeoutMs === undefined) return;
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1) {
    throw new Error('createDb: statementTimeoutMs must be an integer >= 1');
  }
  const overriding = TIMEOUT_OVERRIDING_PARAMETERS.find((name) => url.searchParams.has(name));
  if (overriding !== undefined) {
    throw new ConnectionStringOptionsError(overriding);
  }
}

/** The one member the latency patch replaces, typed as the wrapper needs it. */
interface QueryingClient {
  query: (...args: unknown[]) => unknown;
}

function isQueryingClient(value: unknown): value is QueryingClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    'query' in value &&
    typeof value.query === 'function'
  );
}

/**
 * Wraps a pooled client's query method with a fixed pre-statement delay.
 * Patching at the client level (not the Pool) is what makes the delay
 * per-statement: drizzle runs transactions as begin/.../commit on one
 * checked-out client, so every statement in a transaction pays the delay.
 */
function delayClientStatements(client: PoolClient, latencyMs: number): void {
  if (!isQueryingClient(client)) {
    throw new TypeError('createDb: the pooled client exposes no query method to delay');
  }
  const querying: QueryingClient = client;
  // The bound original keeps pg's overload dispatch (promise and callback
  // forms) intact; the wrapper only defers invocation.
  const original = querying.query.bind(querying);
  const delayed = async (...args: unknown[]): Promise<unknown> => {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return original(...args);
  };
  querying.query = delayed;
}

/** The name a serial pool's overlap refusal carries: how code outside this package recognises it. */
export const SERIAL_POOL_OVERLAP_ERROR_NAME = 'SerialPoolOverlapError';

class SerialPoolOverlapError extends Error {
  override name = SERIAL_POOL_OVERLAP_ERROR_NAME;

  constructor() {
    super(
      'createDb: an acquire reached a serial pool while its connection was checked out. ' +
        'Await the statement in flight before issuing the next, and inside a transaction ' +
        'issue statements through its own handle.'
    );
  }
}

type AcquireCallback = Parameters<Pool['connect']>[0];

/**
 * pg-pool's `query` acquires through `connect` too, so overriding it here
 * covers every statement and every transaction the pool serves. The connection
 * is taken while it is connecting or checked out (counted but not idle), and
 * while an earlier acquire waits in the queue for the idle connection, which
 * pg-pool hands over only on a later tick.
 */
class SerialPool extends Pool {
  override connect(): Promise<PoolClient>;
  override connect(callback: AcquireCallback): void;
  override connect(callback?: AcquireCallback): Promise<PoolClient> | undefined {
    if (this.totalCount > this.idleCount || this.waitingCount > 0) {
      const defect = new SerialPoolOverlapError();
      if (callback === undefined) return Promise.reject(defect);
      callback(defect, undefined, () => undefined);
      return undefined;
    }
    if (callback === undefined) return super.connect();
    super.connect(callback);
    return undefined;
  }
}

export function createDb(connectionString: string, options: DbOptions = {}): Database {
  validate(connectionString, options);

  if (options.neonDev) {
    neonConfig.wsProxy = options.neonDev.wsProxy;
    neonConfig.useSecureWebSocket = options.neonDev.useSecureWebSocket;
    neonConfig.pipelineTLS = options.neonDev.pipelineTLS;
    neonConfig.pipelineConnect = options.neonDev.pipelineConnect;
  }

  const PoolClass = options.serial === true ? SerialPool : Pool;
  const pool = new PoolClass({
    connectionString,
    max: options.poolSize ?? 1,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    // The startup `options` form, never pg's bare `statement_timeout` key:
    // Neon's proxy forwards `options` and drops the bare key without error.
    ...(options.statementTimeoutMs === undefined
      ? {}
      : { options: `-c statement_timeout=${String(options.statementTimeoutMs)}` }),
  });

  // pg-pool re-emits an idle client's error here after it has already removed that
  // client, and the next acquire reconnects; with no listener the emit throws out of
  // a socket callback, which kills a Node process and is uncaught in a Durable Object.
  pool.on('error', () => undefined);
  // pg-pool strips its idle listener from a client it checks out, so a connection that
  // drops mid-checkout emits on the client alone. The statement in flight still rejects
  // to its caller, and release discards a client that is no longer queryable.
  pool.on('connect', (client: PoolClient) => {
    client.on('error', () => undefined);
  });

  const latencyMs = options.injectLatencyMs ?? 0;
  if (latencyMs > 0) {
    // 'connect' fires once per physical connection, before it serves queries,
    // so every client this pool ever hands out carries the delay.
    pool.on('connect', (client: PoolClient) => {
      delayClientStatements(client, latencyMs);
    });
  }

  return drizzle(pool, { schema });
}
