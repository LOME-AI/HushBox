import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, SERIAL_POOL_OVERLAP_ERROR_NAME, createDb } from '@hushbox/db';
import { errAsync, okAsync } from '../result/index.js';
import { unavailableError } from '../errors/index.js';
import { createBoundedRedis } from '../resilience/bounded-redis.js';
import { timeoutPolicy } from '../resilience/policies.js';
import { FINGERPRINT_CODES } from '../telemetry/index.js';
import { createSentryTelemetry } from '../telemetry/adapters/sentry-adapter.js';
import { runCronEntries, runOrThrow } from './cron.js';
import type { Socket } from 'node:net';
import type { DependencyFailureArm } from '../context/dependency-failure.js';
import type { SafeLogFields, Telemetry } from '../telemetry/index.js';

interface TelemetryRecorder {
  readonly telemetry: Telemetry;
  readonly errors: { msg: string; fields: SafeLogFields | undefined }[];
  readonly captured: { message: string; code: string }[];
  readonly capturedErrors: Error[];
}

function recordingTelemetry(): TelemetryRecorder {
  const errors: TelemetryRecorder['errors'] = [];
  const captured: TelemetryRecorder['captured'] = [];
  const capturedErrors: Error[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    captureError: (error: Error, code: string) => {
      captured.push({ message: error.message, code });
      capturedErrors.push(error);
    },
  };
  return { telemetry, errors, captured, capturedErrors };
}

interface Gate {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function gate(): Gate {
  let resolveGate: () => void = () => {};
  let rejectGate: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  return { promise, resolve: resolveGate, reject: rejectGate };
}

/** Lets every already-queued microtask and timer callback run. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('runCronEntries', () => {
  it('starts an entry only after the one before it resolves', async () => {
    const started: string[] = [];
    const first = gate();
    const pass = runCronEntries(
      [
        {
          name: 'slow-first-entry',
          run: () => {
            started.push('first');
            return first.promise;
          },
        },
        {
          name: 'second-entry',
          run: () => {
            started.push('second');
            return Promise.resolve();
          },
        },
      ],
      recordingTelemetry().telemetry
    );
    await drain();
    expect(started).toEqual(['first']);
    first.resolve();
    await pass;
    expect(started).toEqual(['first', 'second']);
  });

  it('starts an entry only after the one before it rejects', async () => {
    const started: string[] = [];
    const first = gate();
    const recorder = recordingTelemetry();
    const pass = runCronEntries(
      [
        {
          name: 'failing-first-entry',
          run: () => {
            started.push('first');
            return first.promise;
          },
        },
        {
          name: 'second-entry',
          run: () => {
            started.push('second');
            return Promise.resolve();
          },
        },
      ],
      recorder.telemetry
    );
    await drain();
    expect(started).toEqual(['first']);
    first.reject(new Error('boom'));
    await pass;
    expect(started).toEqual(['first', 'second']);
    expect(recorder.captured).toEqual([{ message: 'boom', code: 'cron_entry_failed' }]);
  });

  it('runs every entry even when an earlier one throws', async () => {
    const ran: string[] = [];
    const { telemetry } = recordingTelemetry();
    await runCronEntries(
      [
        {
          name: 'first-exploding-entry',
          run: () => {
            ran.push('first');
            return Promise.reject(new Error('boom'));
          },
        },
        {
          name: 'second-healthy-entry',
          run: () => {
            ran.push('second');
            return Promise.resolve();
          },
        },
      ],
      telemetry
    );
    expect(ran).toEqual(['first', 'second']);
  });

  it('captures each failing entry with its name in the structured log', async () => {
    const recorder = recordingTelemetry();
    await runCronEntries(
      [
        { name: 'broken-entry', run: () => Promise.reject(new Error('boom')) },
        { name: 'healthy-entry', run: () => Promise.resolve() },
      ],
      recorder.telemetry
    );
    expect(recorder.errors).toEqual([
      {
        msg: 'cron entry failed',
        fields: { jobType: 'broken-entry', errorCode: 'cron_entry_failed' },
      },
    ]);
    expect(recorder.captured).toEqual([{ message: 'boom', code: 'cron_entry_failed' }]);
  });

  it('wraps a non-Error rejection before capturing it', async () => {
    const recorder = recordingTelemetry();
    await runCronEntries(
      [
        {
          name: 'string-thrower',
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the runner must wrap exactly this non-Error rejection shape
          run: () => Promise.reject('plain string'),
        },
      ],
      recorder.telemetry
    );
    expect(recorder.captured).toEqual([{ message: 'plain string', code: 'cron_entry_failed' }]);
  });

  it('stays silent when every entry succeeds', async () => {
    const recorder = recordingTelemetry();
    await runCronEntries(
      [{ name: 'healthy-entry', run: () => Promise.resolve() }],
      recorder.telemetry
    );
    expect(recorder.errors).toEqual([]);
    expect(recorder.captured).toEqual([]);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required: run through a package test script.');
}

/** Far below the pool's own deadline, far above a local acquire. */
const SHORT_POOL_DEADLINE_MS = 50;

/**
 * A real pg-pool queued-acquire timeout as a cron entry meets it: the pool's
 * one connection checked out, and a statement whose acquire outlives the
 * pool's own deadline, rejected through drizzle's own query error.
 */
async function drizzleWrappedAcquireTimeout(): Promise<Error> {
  const db = createDb(DATABASE_URL ?? '', { neonDev: LOCAL_NEON_DEV_CONFIG });
  db.$client.options.connectionTimeoutMillis = SHORT_POOL_DEADLINE_MS;
  const held = await db.$client.connect();
  const thrown = await db.execute(sql`select 1`).then(
    () => new Error('the statement was served'),
    (error: unknown) => error
  );
  held.release();
  await db.$client.end();
  if (!(thrown instanceof Error)) throw new Error('the driver rejected with a non-Error');
  return thrown;
}

interface SentryEnvelopeItem {
  readonly headers: { readonly type?: string };
  readonly payload: { readonly tags?: Record<string, unknown> };
}

/** The tags on each error event a spy transport received. */
function sentryEventTags(envelopes: readonly unknown[]): Record<string, unknown>[] {
  const tags: Record<string, unknown>[] = [];
  for (const envelope of envelopes) {
    const [, items] = envelope as [
      unknown,
      [SentryEnvelopeItem['headers'], SentryEnvelopeItem['payload']][],
    ];
    for (const [headers, payload] of items) {
      if (headers.type === 'event') tags.push(payload.tags ?? {});
    }
  }
  return tags;
}

describe('runCronEntries: a failure the dependency classifier names', () => {
  it('is captured once under the dependency code instead of the entry code', async () => {
    const thrown = await drizzleWrappedAcquireTimeout();
    const recorder = recordingTelemetry();

    await runCronEntries(
      [{ name: 'starved-entry', run: () => Promise.reject(thrown) }],
      recorder.telemetry
    );

    expect(recorder.captured.map(({ code }) => code)).toEqual([
      FINGERPRINT_CODES.dependencyUnavailable,
    ]);
  });

  it('logs the dependency code beside the entry name', async () => {
    const thrown = await drizzleWrappedAcquireTimeout();
    const recorder = recordingTelemetry();

    await runCronEntries(
      [{ name: 'starved-entry', run: () => Promise.reject(thrown) }],
      recorder.telemetry
    );

    expect(recorder.errors).toEqual([
      {
        msg: 'cron entry failed',
        fields: { jobType: 'starved-entry', errorCode: FINGERPRINT_CODES.dependencyUnavailable },
      },
    ]);
  });

  it('reaches the Sentry wire naming postgres and the acquire timeout, and none of the query', async () => {
    const thrown = await drizzleWrappedAcquireTimeout();
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    const telemetry = createSentryTelemetry({
      dsn: 'https://abc123@o1.ingest.sentry.io/42',
      transport: () => ({
        send: (envelope: unknown) => {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
      scheduleFlush: (task) => flushes.push(task),
    });

    await runCronEntries([{ name: 'starved-entry', run: () => Promise.reject(thrown) }], telemetry);
    await Promise.all(flushes);

    expect(sentryEventTags(envelopes)).toEqual([
      {
        errorCode: FINGERPRINT_CODES.dependencyUnavailable,
        dependency: 'postgres',
        dependencyFailure: 'acquire-timeout',
        dependencyLate: false,
      },
    ]);
    expect(JSON.stringify(envelopes)).not.toContain('select 1');
  });
});

/** Well under a test's patience, far enough above a microtask to be a real wait. */
const SHORT_REDIS_DEADLINE_MS = 40;

const REDIS_CREDENTIALS = { url: 'http://localhost:8079', token: 'token' } as const;

/** The rejection a promise settles with, having asserted that it rejected. */
async function rejectionOf(work: Promise<unknown>): Promise<Error> {
  const outcome = await work.then(
    () => ({ settled: 'resolved' as const }),
    (error: unknown) => ({ settled: 'rejected' as const, error })
  );
  if (outcome.settled === 'resolved') throw new Error('expected the work to reject');
  if (!(outcome.error instanceof Error)) throw new Error('the work rejected with a non-Error');
  return outcome.error;
}

/** A unique-key violation the server answers, rejected through drizzle's own query error. */
async function drizzleWrappedUniqueViolation(): Promise<Error> {
  const db = createDb(DATABASE_URL ?? '', { neonDev: LOCAL_NEON_DEV_CONFIG });
  const thrown = await rejectionOf(
    db.transaction(async (tx) => {
      await tx.execute(sql`create temp table cron_probe (id int primary key) on commit drop`);
      await tx.execute(sql`insert into cron_probe values (1), (1)`);
    })
  );
  await db.$client.end();
  return thrown;
}

/**
 * A serial pool's refusal of an acquire that overlaps its checked-out
 * connection, rejected through drizzle's own query error.
 */
async function drizzleWrappedSerialOverlap(): Promise<Error> {
  const db = createDb(DATABASE_URL ?? '', { neonDev: LOCAL_NEON_DEV_CONFIG, serial: true });
  const held = await db.$client.connect();
  const thrown = await rejectionOf(db.execute(sql`select 1`));
  held.release();
  await db.$client.end();
  return thrown;
}

/** The pool's connecting deadline, met against an endpoint that accepts and never answers. */
async function poolConnectTimeout(): Promise<Error> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port bound');
  const db = createDb(`postgres://nobody:nothing@127.0.0.1:${String(address.port)}/none`, {
    neonDev: LOCAL_NEON_DEV_CONFIG,
  });
  db.$client.options.connectionTimeoutMillis = SHORT_POOL_DEADLINE_MS;
  const thrown = await rejectionOf(db.execute(sql`select 1`));
  for (const socket of sockets) socket.destroy();
  server.close();
  await db.$client.end();
  return thrown;
}

/** A statement the server cancelled at its own bound. */
async function statementTimeout(): Promise<Error> {
  const db = createDb(DATABASE_URL ?? '', { neonDev: LOCAL_NEON_DEV_CONFIG });
  const thrown = await rejectionOf(
    db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = 10`);
      await tx.execute(sql`select pg_sleep(1)`);
    })
  );
  await db.$client.end();
  return thrown;
}

/**
 * A bounded Redis command's failure as a cron entry throws it: wrapped as every
 * Redis operation wraps it, then bridged through the entry's throw channel.
 */
async function boundedRedisFailure(fetchStub: typeof globalThis.fetch): Promise<Error> {
  vi.stubGlobal('fetch', fetchStub);
  const redis = createBoundedRedis(REDIS_CREDENTIALS, SHORT_REDIS_DEADLINE_MS);
  const domainError = unavailableError('redis get failed', await rejectionOf(redis.get('key')));
  return rejectionOf(runOrThrow(errAsync(domainError)));
}

function neverAnsweringFetch(): typeof globalThis.fetch {
  return () => new Promise<Response>(() => {});
}

/** An answer the client cannot read as one entry per command, which it throws on itself. */
function unreadableFetch(): typeof globalThis.fetch {
  return () => Promise.resolve(Response.json({}, { status: 200 }));
}

/** A resilience-policy expiry with no Postgres or Redis link in its chain, bridged as an entry throws it. */
function unclaimedPolicyDeadline(): Promise<Error> {
  return rejectionOf(
    runOrThrow(timeoutPolicy({ timeoutMs: 1 }).run(() => new Promise<never>(() => {})))
  );
}

/** The `name` of every link in an error's cause chain, outermost first. */
function causeChainNames(error: Error | undefined): string[] {
  const names: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    names.push(current.name);
    current = current.cause;
  }
  return names;
}

describe('runCronEntries: a failure that names a defect rather than an outage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures an error the database answered as the entry failure', async () => {
    const thrown = await drizzleWrappedUniqueViolation();
    const recorder = recordingTelemetry();

    await runCronEntries(
      [{ name: 'violating-entry', run: () => Promise.reject(thrown) }],
      recorder.telemetry
    );

    expect(recorder.captured.map(({ code }) => code)).toEqual([FINGERPRINT_CODES.cronEntryFailed]);
  });

  it('captures the error the database answered as the very object the entry threw', async () => {
    const thrown = await drizzleWrappedUniqueViolation();
    const recorder = recordingTelemetry();

    await runCronEntries(
      [{ name: 'violating-entry', run: () => Promise.reject(thrown) }],
      recorder.telemetry
    );

    expect(recorder.capturedErrors[0]).toBe(thrown);
    expect(recorder.capturedErrors[0]?.cause).toMatchObject({ code: '23505' });
  });

  it('captures a serial pool overlap refusal as the entry failure', async () => {
    const thrown = await drizzleWrappedSerialOverlap();
    const recorder = recordingTelemetry();

    await runCronEntries(
      [{ name: 'overlapping-entry', run: () => Promise.reject(thrown) }],
      recorder.telemetry
    );

    expect(recorder.captured.map(({ code }) => code)).toEqual([FINGERPRINT_CODES.cronEntryFailed]);
  });

  it('captures a serial pool overlap refusal as the very object the entry threw', async () => {
    const thrown = await drizzleWrappedSerialOverlap();
    const recorder = recordingTelemetry();

    await runCronEntries(
      [{ name: 'overlapping-entry', run: () => Promise.reject(thrown) }],
      recorder.telemetry
    );

    expect(recorder.capturedErrors[0]).toBe(thrown);
    expect(causeChainNames(recorder.capturedErrors[0])).toContain(SERIAL_POOL_OVERLAP_ERROR_NAME);
  });

  it('captures a policy deadline no dependency claims as the entry failure', async () => {
    const thrown = await unclaimedPolicyDeadline();
    const recorder = recordingTelemetry();

    await runCronEntries(
      [{ name: 'expired-entry', run: () => Promise.reject(thrown) }],
      recorder.telemetry
    );

    expect(recorder.captured.map(({ code }) => code)).toEqual([FINGERPRINT_CODES.cronEntryFailed]);
  });

  it('captures a policy deadline no dependency claims as the very object the entry threw', async () => {
    const thrown = await unclaimedPolicyDeadline();
    const recorder = recordingTelemetry();

    await runCronEntries(
      [{ name: 'expired-entry', run: () => Promise.reject(thrown) }],
      recorder.telemetry
    );

    expect(recorder.capturedErrors[0]).toBe(thrown);
  });
});

describe('runCronEntries: a failure that says the dependency was not reached', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['acquire-timeout', drizzleWrappedAcquireTimeout],
    ['connect-timeout', poolConnectTimeout],
    ['statement-timeout', statementTimeout],
    ['deadline', () => boundedRedisFailure(neverAnsweringFetch())],
    ['transport', () => boundedRedisFailure(unreadableFetch())],
  ] as const)(
    'captures a %s under the dependency code',
    async (failure: DependencyFailureArm, produce: () => Promise<Error>) => {
      const thrown = await produce();
      const recorder = recordingTelemetry();

      await runCronEntries(
        [{ name: 'unreached-entry', run: () => Promise.reject(thrown) }],
        recorder.telemetry
      );

      expect(recorder.captured.map(({ code }) => code)).toEqual([
        FINGERPRINT_CODES.dependencyUnavailable,
      ]);
      expect(recorder.capturedErrors[0]).toMatchObject({ dependencyFailure: failure });
    }
  );
});

describe('runCronEntries: what the pass reports back', () => {
  it('says an entry failed when one rejected', async () => {
    const outcome = await runCronEntries(
      [
        { name: 'broken-entry', run: () => Promise.reject(new Error('x')) },
        { name: 'healthy-entry', run: () => Promise.resolve() },
      ],
      recordingTelemetry().telemetry
    );

    expect(outcome).toEqual({ anyFailed: true });
  });

  it('says no entry failed when every one resolved', async () => {
    const outcome = await runCronEntries(
      [{ name: 'healthy-entry', run: () => Promise.resolve() }],
      recordingTelemetry().telemetry
    );

    expect(outcome).toEqual({ anyFailed: false });
  });
});

describe('runOrThrow', () => {
  it('returns the ok value', async () => {
    await expect(runOrThrow(okAsync(42))).resolves.toBe(42);
  });

  it('throws the domain code with the domain error as cause', async () => {
    const domainError = unavailableError('redis down');
    const thrown = await runOrThrow(errAsync(domainError)).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('unavailable');
    expect((thrown as Error).cause).toBe(domainError);
  });
});
