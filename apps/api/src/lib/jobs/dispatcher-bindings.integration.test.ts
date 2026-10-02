import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import {
  createAppJobRegistry,
  createDispatcherDbScope,
  createDispatcherTelemetry,
  createJobDispatcherBindings,
  openDispatcherDb,
} from './dispatcher-bindings.js';
import { enqueueWithinTx } from './enqueue.js';
import { collectJobWake, createJobWakeCollector, grantJobWakes } from './wake-capability.js';
import { runSettlement } from '../idempotency/index.js';
import {
  PAYMENT_VERIFY_JOB_TYPE,
  createBillingStores,
  createPaymentVerifyJobRegistration,
} from '../../slices/billing/index.js';
import { FINGERPRINT_CODES } from '../telemetry/index.js';
import type { PaymentProvider } from '../../slices/billing/index.js';
import type { JobDispatcherNamespace } from './wake.js';
import type {
  ConsoleSink,
  DurableObjectTelemetryOptions,
  SentryTransportFactory,
  Telemetry,
} from '../telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

// A provider stub whose methods never run in these tests: the payment-verify
// handler dead-letters on the absent pre-claim row before it reaches the
// provider. Present only to satisfy the registration's dependency set.
const idleProvider: PaymentProvider = {
  isMock: true,
  charge: () => {
    throw new Error('provider.charge unexpectedly invoked');
  },
  getChargeStatus: () => {
    throw new Error('provider.getChargeStatus unexpectedly invoked');
  },
  findCaptureByReference: () => {
    throw new Error('provider.findCaptureByReference unexpectedly invoked');
  },
};

/** The registrations the app hands to `createAppJobRegistry` (billing's, today). */
function appRegistrations(
  db: ReturnType<typeof createDb>
): ReturnType<typeof createPaymentVerifyJobRegistration>[] {
  return [
    createPaymentVerifyJobRegistration({
      db,
      stores: createBillingStores(),
      resolveProvider: () => idleProvider,
    }),
  ];
}

interface Recorded {
  readonly port: Telemetry;
  readonly errors: string[];
  readonly captured: { message: string; errorCode: string }[];
}

function recordingTelemetry(): Recorded {
  const errors: string[] = [];
  const captured: { message: string; errorCode: string }[] = [];
  return {
    port: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg) => {
        errors.push(msg);
      },
      captureError: (error, errorCode) => {
        captured.push({ message: error.message, errorCode });
      },
    },
    errors,
    captured,
  };
}

describe('createDispatcherTelemetry', () => {
  it('maps a failed pass onto the typed port with an error capture', () => {
    const recorded = recordingTelemetry();
    createDispatcherTelemetry(recorded.port).passFailed({ shard: 'bulk' });
    expect(recorded.errors).toEqual(['job dispatcher pass failed']);
    expect(recorded.captured).toEqual([
      { message: 'job dispatcher pass failed on shard bulk', errorCode: 'job_pass_failed' },
    ]);
  });
});

describe('createAppJobRegistry', () => {
  it('registers nothing when given no registrations (the lib-resident default)', () => {
    expect(createAppJobRegistry().types()).toEqual([]);
  });

  it('registers and resolves the payment-verify job from the handed registration', () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    try {
      const registry = createAppJobRegistry(appRegistrations(db));
      expect(registry.types()).toContain(PAYMENT_VERIFY_JOB_TYPE);
      const registered = registry.get(PAYMENT_VERIFY_JOB_TYPE);
      expect(registered).toBeDefined();
      // The executor dead-letters an unknown type OR an unparseable payload;
      // a resolvable registration whose schema accepts the payload passes both
      // gates — the job executes rather than dead-lettering.
      expect(registered?.schema.safeParse({ paymentId: crypto.randomUUID() }).success).toBe(true);
      expect(registered?.schema.safeParse({}).success).toBe(false);
    } finally {
      // Never queried (registration only), but close the client so the test
      // leaves no socket open.
      void db.$client.end();
    }
  });
});

describe('openDispatcherDb', () => {
  it('builds a local-proxy client in dev and a direct client otherwise', async () => {
    const dev = openDispatcherDb(DATABASE_URL, { isDev: true });
    const production = openDispatcherDb(DATABASE_URL, { isDev: false });
    expect(dev).toBeDefined();
    expect(production).toBeDefined();
    await dev.$client.end();
    await production.$client.end();
  });
});

describe('createJobDispatcherBindings', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() =>
      createJobDispatcherBindings(
        { NODE_ENV: 'development', TELEMETRY_SINKS: 'console' },
        createAppJobRegistry()
      )
    ).toThrow('DATABASE_URL');
  });

  it('binds an executor that runs a real pass per invocation', async () => {
    const bindings = createJobDispatcherBindings(
      { NODE_ENV: 'development', DATABASE_URL, TELEMETRY_SINKS: 'console' },
      createAppJobRegistry()
    );
    // What this test owns is the WIRING: the binding produces an executor that
    // runs a real pass against the real DB and returns structured re-arm advice.
    // The specific `idle` mapping (empty shard → `{ kind: 'idle' }`) is a
    // shard-global property — a `media.reclaimUser.v1` row an identity-deletion
    // test left on this slot's database legitimately flips it to
    // `scheduled`/`due` — so it is asserted against a controlled,
    // foreign-row-free DB in the `pass.test.ts` unit suite instead. Here we only
    // assert the pass ran and produced a well-formed result.
    const result = await bindings.executor.runPass('bulk');
    expect(['idle', 'due', 'scheduled']).toContain(result.kind);
    expect(typeof bindings.now()).toBe('number');
  });
});

describe('createAppJobRegistry: payment-verify executes through a real pass', () => {
  const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  const enqueuedJobIds: string[] = [];

  afterAll(async () => {
    for (const id of enqueuedJobIds) {
      await db.delete(jobs).where(eq(jobs.id, id));
    }
    await db.$client.end();
  });

  it('claims and runs the job via its handler — never the unregistered-type dead-letter', async () => {
    const registry = createAppJobRegistry(appRegistrations(db));
    const bindings = createJobDispatcherBindings(
      { NODE_ENV: 'development', DATABASE_URL, TELEMETRY_SINKS: 'console' },
      registry
    );
    // No pre-claim row exists, so the handler dead-letters with ITS reason —
    // proving it resolved and executed rather than the executor's
    // unknown-type dead-letter. The `afterAll` above deletes the row this
    // test commits.
    const paymentId = crypto.randomUUID();
    const enqueue = await db.transaction((tx) =>
      enqueueWithinTx(grantJobWakes(tx, createJobWakeCollector()), registry, {
        type: PAYMENT_VERIFY_JOB_TYPE,
        payload: { paymentId },
        shard: 'bulk',
        dedupeKey: `test:payment.verify:${paymentId}`,
      })
    );
    if (!enqueue.enqueued) throw new Error('payment-verify enqueue was deduped unexpectedly');
    enqueuedJobIds.push(enqueue.jobId);

    await bindings.executor.runPass('bulk');

    const rows = await db.select().from(jobs).where(eq(jobs.id, enqueue.jobId));
    const row = rows[0];
    expect(row?.status).toBe('dead');
    const errorText = JSON.stringify(row?.errors ?? []);
    expect(errorText).toContain('payment pre-claim row does not exist');
    expect(errorText).not.toContain('unregistered job type');
  });
});

const SENTRY_DSN = 'https://abc123@o1.ingest.sentry.io/42';

function spyTransport(): {
  factory: SentryTransportFactory;
  envelopes: unknown[];
  constructions: number[];
} {
  const envelopes: unknown[] = [];
  const constructions: number[] = [];
  return {
    factory: () => {
      constructions.push(constructions.length);
      return {
        send: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      };
    },
    envelopes,
    constructions,
  };
}

function recordingSink(): { sink: ConsoleSink; lines: string[] } {
  const lines: string[] = [];
  const record = (line: string): void => {
    lines.push(line);
  };
  return { sink: { debug: record, info: record, warn: record, error: record }, lines };
}

/** A failed pass is the shard's own capture path — the DispatcherTelemetry event that pages. */
function failOnePass(env: Record<string, string>, options: DurableObjectTelemetryOptions): void {
  createJobDispatcherBindings(
    env as Parameters<typeof createJobDispatcherBindings>[0],
    createAppJobRegistry(),
    options
  ).telemetry.passFailed({ shard: 'default' });
}

describe('createJobDispatcherBindings telemetry composition', () => {
  it('delivers a capture to the Sentry transport when the environment asks for the sink', async () => {
    const transport = spyTransport();

    failOnePass(
      { NODE_ENV: 'development', DATABASE_URL, TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN },
      { consoleSink: recordingSink().sink, sentryTransport: transport.factory }
    );

    await vi.waitFor(() => {
      expect(transport.envelopes).toHaveLength(1);
    });
    expect(JSON.stringify(transport.envelopes)).toContain(FINGERPRINT_CODES.jobPassFailed);
  });

  it('builds the Sentry client once for the isolate rather than once per capture', async () => {
    const transport = spyTransport();
    const bindings = createJobDispatcherBindings(
      {
        NODE_ENV: 'development',
        DATABASE_URL,
        TELEMETRY_SINKS: 'console,sentry',
        SENTRY_DSN,
      },
      createAppJobRegistry(),
      { consoleSink: recordingSink().sink, sentryTransport: transport.factory }
    );

    bindings.telemetry.passFailed({ shard: 'default' });
    bindings.telemetry.passFailed({ shard: 'bulk' });

    await vi.waitFor(() => {
      expect(transport.envelopes).toHaveLength(2);
    });
    expect(transport.constructions).toHaveLength(1);
  });

  it('degrades to console rather than throwing when the sink list is unparseable', () => {
    const recorded = recordingSink();
    const transport = spyTransport();

    expect(() => {
      failOnePass(
        { NODE_ENV: 'development', DATABASE_URL, TELEMETRY_SINKS: 'console,statsd' },
        { consoleSink: recorded.sink, sentryTransport: transport.factory }
      );
    }).not.toThrow();
    expect(recorded.lines.join('\n')).toContain(FINGERPRINT_CODES.jobPassFailed);
    expect(transport.envelopes).toHaveLength(0);
  });

  it('degrades to console rather than throwing when the sentry sink has no DSN', () => {
    const recorded = recordingSink();
    const transport = spyTransport();

    expect(() => {
      failOnePass(
        {
          NODE_ENV: 'development',
          DATABASE_URL,
          TELEMETRY_SINKS: 'console,sentry',
          SENTRY_DSN: '',
        },
        { consoleSink: recorded.sink, sentryTransport: transport.factory }
      );
    }).not.toThrow();
    expect(recorded.lines.join('\n')).toContain(FINGERPRINT_CODES.jobPassFailed);
    expect(transport.envelopes).toHaveLength(0);
  });
});

interface RecordingDispatcher {
  readonly namespace: JobDispatcherNamespace<string>;
  readonly woken: string[];
}

/** Stands in for the dispatcher DO binding, recording which shards were nudged. */
function recordingDispatcher(): RecordingDispatcher {
  const woken: string[] = [];
  return {
    namespace: {
      idFromName: (name: string): string => name,
      get: (id: string) => ({
        fetch: (): Promise<unknown> => {
          woken.push(id);
          return Promise.resolve();
        },
      }),
    },
    woken,
  };
}

describe('createDispatcherDbScope', () => {
  const runScopedPass = async (outcome: 'commit' | 'abort'): Promise<string[]> => {
    const dispatcher = recordingDispatcher();
    const scope = createDispatcherDbScope(
      { NODE_ENV: 'development', DATABASE_URL, JOB_DISPATCHER: dispatcher.namespace },
      DATABASE_URL
    );
    const pass = scope((db) =>
      runSettlement(db, async (tx) => {
        collectJobWake(tx, 'bulk');
        await tx.execute(sql`select 1 as one`);
        if (outcome === 'abort') throw new Error('dispatcher transaction aborted');
      })
    );
    if (outcome === 'abort') {
      await expect(pass).rejects.toThrow('dispatcher transaction aborted');
    } else {
      await pass;
    }
    return dispatcher.woken;
  };

  it('nudges the dispatcher for a shard collected in a committed pass transaction', async () => {
    expect(await runScopedPass('commit')).toEqual(['bulk']);
  });

  it('nudges nothing when the pass transaction rolls back', async () => {
    expect(await runScopedPass('abort')).toEqual([]);
  });
});
