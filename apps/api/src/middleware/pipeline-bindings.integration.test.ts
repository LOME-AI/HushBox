import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { pipelineEnv } from './pipeline-env.js';
import { pipelineBindings } from './pipeline-bindings.js';
import { runSettlement } from '../lib/idempotency/index.js';
import { collectJobWake } from '../lib/jobs/index.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { JobDispatcherNamespace, JobShard } from '../lib/jobs/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/**
 * The request pool's lifetime against REAL Postgres: the unit suite proves the
 * ordering with a stubbed `end()`, this proves the consequence the ordering
 * exists for — a post-response side-band still gets a working pool, so no
 * "cannot use a pool after calling end" reaches a notification path.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `pipeline-bindings integration: missing ${name}. Run via a package test script.`
    );
  }
  return value;
}

const realEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

describe('the request pool under post-response work', () => {
  it('serves a side-band query issued after the response was returned', async () => {
    const sideBandTasks: Promise<unknown>[] = [];
    let releaseSideBand = (): void => {
      throw new Error('gate not installed');
    };
    const gate = new Promise<void>((resolve) => {
      releaseSideBand = resolve;
    });
    const outcome: { value: unknown; failure: string | undefined } = {
      value: undefined,
      failure: undefined,
    };
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        c.var.sideBand(
          (async () => {
            await gate;
            try {
              const rows = await c.var.db.execute(sql`select 1 as one`);
              outcome.value = rows.rows[0];
              // eslint-disable-next-line catch-swallow/no-silent-catch -- the throw IS the assertion subject: it is recorded into `outcome.failure` and read after the side-band task settles
            } catch (error) {
              outcome.failure = error instanceof Error ? error.message : String(error);
            }
          })()
        );
        return c.json({ ok: true });
      });

    const response = await app.request('/probe', {}, realEnv, {
      waitUntil: (task: Promise<unknown>): void => {
        sideBandTasks.push(task);
      },
      passThroughOnException: (): void => {
        // Unused; present to satisfy the ExecutionContext shape.
      },
      props: {},
    });

    expect(response.status).toBe(200);
    // Only now, with the response fully consumed, does the side-band run its
    // query — the window in which the pool used to already be closing.
    releaseSideBand();
    await Promise.all(sideBandTasks);

    expect(outcome.failure).toBeUndefined();
    expect(outcome.value).toEqual({ one: 1 });
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

function wakeProbeApp(shard: JobShard, outcome: 'commit' | 'abort'): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', pipelineEnv())
    .use('*', pipelineBindings())
    .get('/probe', async (c) => {
      await runSettlement(c.var.db, async (tx) => {
        collectJobWake(tx, shard);
        await tx.execute(sql`select 1 as one`);
        if (outcome === 'abort') throw new Error('request transaction aborted');
      });
      return c.json({ ok: true });
    })
    .onError((error, c) => c.json({ message: error.message }, 500));
}

describe('the request-scoped wake capability', () => {
  it('nudges the dispatcher for a shard collected in a committed request transaction', async () => {
    const dispatcher = recordingDispatcher();

    const response = await wakeProbeApp('bulk', 'commit').request(
      '/probe',
      {},
      {
        ...realEnv,
        JOB_DISPATCHER: dispatcher.namespace,
      }
    );

    expect(response.status).toBe(200);
    expect(dispatcher.woken).toEqual(['bulk']);
  });

  it('nudges nothing when the request transaction rolls back', async () => {
    const dispatcher = recordingDispatcher();

    const response = await wakeProbeApp('bulk', 'abort').request(
      '/probe',
      {},
      {
        ...realEnv,
        JOB_DISPATCHER: dispatcher.namespace,
      }
    );

    expect(response.status).toBe(500);
    expect(dispatcher.woken).toEqual([]);
  });
});
