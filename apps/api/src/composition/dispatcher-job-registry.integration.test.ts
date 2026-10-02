import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  createDispatcherJobRegistry,
  openDispatcherDbFromEnv,
  openDispatcherRedis,
} from './dispatcher-job-registry.js';
import { PAYMENT_VERIFY_JOB_TYPE } from '../slices/billing/index.js';
import { SESSION_REVOKE_JOB_TYPE } from '../slices/identity/index.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE } from '../slices/media/index.js';
import { NEWSLETTER_DISPATCH_JOB_TYPE } from '../slices/newsletter/index.js';
import { ADMIN_DIGEST_JOB_TYPE } from '../slices/admin/index.js';
import { GROWTH_ROLLUP_HOUR_LOST, GROWTH_ROLLUP_JOB_TYPE } from '../slices/growth/index.js';
import { rateLimitBound } from '../lib/rate-limit/index.js';
import { REALTIME_REDIS_KEYS } from '../lib/redis/define-key.js';
import { IDENTITY_KEYS } from '../slices/identity/domain/keys.js';
import type { JobExecution, JobOutcome, RegisteredJob } from '../lib/jobs/index.js';
import type { Bindings } from '../lib/context/app-env.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`dispatcher registry tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

/**
 * A registered type run the way the dispatcher runs it, whichever shape it
 * declared. Every case here is a wiring check whose work fits one budget, so
 * the clock never moves and no chunk loop ever checkpoints.
 */
function runRegistered(
  registered: RegisteredJob,
  execution: JobExecution<unknown>
): Promise<JobOutcome> {
  return registered.run(execution, { totalMs: 300_000, now: () => TEST_DAY_START });
}

// The env the DO's composition sees. In dev the mock payment provider is
// selected — it fails fast without API_URL/HELCIM_WEBHOOK_VERIFIER, so both are
// supplied exactly as the local stack provides them; the media-reclaim handler's
// R2 storage adapter likewise fails fast without the R2 bindings.
interface DispatcherEnv extends Bindings {
  ADMIN_URL: string;
  API_URL: string;
  MARKETING_URL: string;
  HELCIM_WEBHOOK_VERIFIER: string;
  R2_S3_ENDPOINT: string;
  R2_BUCKET_MEDIA: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

const env: DispatcherEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  ADMIN_URL: requiredEnv('ADMIN_URL'),
  API_URL: requiredEnv('API_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  HELCIM_WEBHOOK_VERIFIER: requiredEnv('HELCIM_WEBHOOK_VERIFIER'),
  R2_S3_ENDPOINT: requiredEnv('R2_S3_ENDPOINT'),
  R2_BUCKET_MEDIA: requiredEnv('R2_BUCKET_MEDIA'),
  R2_ACCESS_KEY_ID: requiredEnv('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requiredEnv('R2_SECRET_ACCESS_KEY'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
};

// A minimal execution for a resolved handler. The payment-verify handler reads
// only `payload.paymentId`; on an absent pre-claim row it returns `dead` before
// touching the fenced completion capability, so it throws if the handler ever
// reaches for it.
function executionWith(payload: unknown): JobExecution<unknown> {
  return {
    jobId: crypto.randomUUID(),
    payload,
    claims: 1,
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

function executionFor(paymentId: string): JobExecution<unknown> {
  return executionWith({ paymentId });
}

describe('openDispatcherDbFromEnv', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => openDispatcherDbFromEnv({ NODE_ENV: 'development' })).toThrow('DATABASE_URL');
  });

  it('fails fast when DATABASE_URL is empty', () => {
    expect(() => openDispatcherDbFromEnv({ NODE_ENV: 'development', DATABASE_URL: '' })).toThrow(
      'DATABASE_URL'
    );
  });

  it('constructs a client from the env binding', async () => {
    const db = openDispatcherDbFromEnv(env);
    expect(db).toBeDefined();
    await db.$client.end();
  });
});

describe('openDispatcherRedis', () => {
  it('fails fast when the Upstash binding is missing', () => {
    expect(() => openDispatcherRedis({ NODE_ENV: 'development', DATABASE_URL })).toThrow(
      'UPSTASH_REDIS_REST_URL/TOKEN'
    );
  });

  it('builds a client from the env binding', () => {
    expect(openDispatcherRedis(env)).toBeDefined();
  });
});

interface EvictCall {
  readonly conversationId: string;
  readonly principalId: string;
}

// A ConversationRoom DO namespace fake that records the /evict fan-out (the DO
// receives the principalId in the body) and answers the expected `{closed}`.
function recordingNamespace(evicted: EvictCall[]): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: (_url: string, init?: RequestInit) => {
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        const body = JSON.parse(raw) as { principalId: string };
        evicted.push({ conversationId: id.name, principalId: body.principalId });
        return Promise.resolve(Response.json({ closed: 1 }));
      },
    }),
  } as unknown as DurableObjectNamespace;
}

// A namespace whose /evict refuses, so the adapter's Result lands on the error
// channel — the arm the fan-out drops on purpose.
function refusingNamespace(attempts: string[]): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: (): Promise<Response> => {
        attempts.push(id.name);
        return Promise.resolve(new Response('unavailable', { status: 503 }));
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function revokeExecutionFor(userId: string): JobExecution<unknown> {
  return executionWith({ userId });
}

/** An empty key list: the sweep returns before it resolves any storage. */
function reclaimExecutionFor(userId: string): JobExecution<unknown> {
  return executionWith({ userId, storageKeys: [], nextIndex: 0 });
}

/**
 * A sweep over one well-formed key naming no live object: R2 delete is
 * idempotent, so the handler resolves the registry's own R2 adapter and
 * deletes through it without the fixture staging an object first.
 */
function reclaimSweepExecutionFor(userId: string): JobExecution<unknown> {
  const mediaKey = `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  return executionWith({ userId, storageKeys: [mediaKey], nextIndex: 0 });
}

describe('createDispatcherJobRegistry — the registry the live JobDispatcher DO runs', () => {
  const db = openDispatcherDbFromEnv(env);
  const redis = openDispatcherRedis(env);
  const createdKeys: string[] = [];
  afterAll(async () => {
    if (createdKeys.length > 0) await redis.del(...createdKeys);
    await db.$client.end();
  });

  it('registers and resolves payment.verify.v1 (not the empty lib-composed default)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(PAYMENT_VERIFY_JOB_TYPE);
    const registered = registry.get(PAYMENT_VERIFY_JOB_TYPE);
    expect(registered).toBeDefined();
    expect(registered?.schema.safeParse({ paymentId: crypto.randomUUID() }).success).toBe(true);
  });

  it('registers and resolves media.reclaimUser.v1 (account deletion enqueues it — must not dead-letter as unknown)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(MEDIA_RECLAIM_USER_JOB_TYPE);
    const registered = registry.get(MEDIA_RECLAIM_USER_JOB_TYPE);
    expect(registered).toBeDefined();
    expect(
      registered?.schema.safeParse({ userId: crypto.randomUUID(), storageKeys: [] }).success
    ).toBe(true);
  });

  it('registers and resolves newsletter.dispatch.v1 (the admin scheduling op enqueues it — must not dead-letter as unknown)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(NEWSLETTER_DISPATCH_JOB_TYPE);
    const registered = registry.get(NEWSLETTER_DISPATCH_JOB_TYPE);
    expect(registered).toBeDefined();
    expect(registered?.shard).toBe('bulk');
    expect(registered?.schema.safeParse({ issueId: crypto.randomUUID() }).success).toBe(true);
  });

  it('still builds every registration when one handler’s configuration is broken', () => {
    const withoutMarketing = { ...env, MARKETING_URL: '' };
    const registry = createDispatcherJobRegistry(withoutMarketing, db);
    expect(registry.types()).toEqual(
      expect.arrayContaining([
        PAYMENT_VERIFY_JOB_TYPE,
        MEDIA_RECLAIM_USER_JOB_TYPE,
        SESSION_REVOKE_JOB_TYPE,
        NEWSLETTER_DISPATCH_JOB_TYPE,
      ])
    );
  });

  it('fails only the broken type’s rows, and does so per row rather than at construction', async () => {
    const withoutMarketing = { ...env, MARKETING_URL: '' };
    const broken = createDispatcherJobRegistry(withoutMarketing, db).get(
      NEWSLETTER_DISPATCH_JOB_TYPE
    );
    if (broken === undefined) throw new Error('newsletter.dispatch.v1 did not resolve');
    // The throw happens inside the handler, on the row, where the executor
    // turns it into a `fail` outcome that consumes the type's failure budget
    // and dead-letters — a per-row operator signal, not a dead dispatcher.
    const execution = executionWith({ issueId: crypto.randomUUID(), nextBatchIndex: 0 });
    await expect(runRegistered(broken, execution)).rejects.toThrow(/API_URL\/MARKETING_URL/);
  });

  it('runs the three healthy handlers to completion under that same broken configuration', async () => {
    const withoutMarketing = { ...env, MARKETING_URL: '' };
    const registry = createDispatcherJobRegistry(withoutMarketing, db);
    const userId = crypto.randomUUID();
    createdKeys.push(IDENTITY_KEYS.passwordChangedAt.buildKey(userId));

    const payment = registry.get(PAYMENT_VERIFY_JOB_TYPE);
    const reclaim = registry.get(MEDIA_RECLAIM_USER_JOB_TYPE);
    const revoke = registry.get(SESSION_REVOKE_JOB_TYPE);
    if (payment === undefined || reclaim === undefined || revoke === undefined) {
      throw new Error('a healthy job type did not resolve');
    }

    await expect(runRegistered(payment, executionFor(crypto.randomUUID()))).resolves.toEqual({
      kind: 'dead',
      error: 'payment pre-claim row does not exist',
    });
    await expect(
      runRegistered(reclaim, reclaimSweepExecutionFor(crypto.randomUUID()))
    ).resolves.toEqual({
      kind: 'ok',
      result: { reclaimed: 1 },
    });
    await expect(runRegistered(revoke, revokeExecutionFor(userId))).resolves.toEqual({
      kind: 'ok',
      result: { revoked: userId },
    });
  });

  it('still builds every registration when the dispatcher Redis binding is absent', () => {
    // Opening Redis at the top of the factory took all four types down, not just
    // the one that needs it.
    const withoutRedis = { ...env, UPSTASH_REDIS_REST_URL: '' };
    const registry = createDispatcherJobRegistry(withoutRedis, db);
    expect(registry.types()).toEqual(
      expect.arrayContaining([
        PAYMENT_VERIFY_JOB_TYPE,
        MEDIA_RECLAIM_USER_JOB_TYPE,
        SESSION_REVOKE_JOB_TYPE,
        NEWSLETTER_DISPATCH_JOB_TYPE,
      ])
    );
  });

  it('runs the three Redis-free handlers to completion under that absent binding', async () => {
    const withoutRedis = { ...env, UPSTASH_REDIS_REST_URL: '' };
    const registry = createDispatcherJobRegistry(withoutRedis, db);

    const payment = registry.get(PAYMENT_VERIFY_JOB_TYPE);
    const reclaim = registry.get(MEDIA_RECLAIM_USER_JOB_TYPE);
    const newsletter = registry.get(NEWSLETTER_DISPATCH_JOB_TYPE);
    const revoke = registry.get(SESSION_REVOKE_JOB_TYPE);
    if (
      payment === undefined ||
      reclaim === undefined ||
      newsletter === undefined ||
      revoke === undefined
    ) {
      throw new Error('a job type did not resolve');
    }

    await expect(runRegistered(payment, executionFor(crypto.randomUUID()))).resolves.toEqual({
      kind: 'dead',
      error: 'payment pre-claim row does not exist',
    });
    await expect(runRegistered(reclaim, reclaimExecutionFor(crypto.randomUUID()))).resolves.toEqual(
      {
        kind: 'ok',
        result: { reclaimed: 0 },
      }
    );
    await expect(
      runRegistered(newsletter, executionWith({ issueId: crypto.randomUUID(), nextBatchIndex: 0 }))
    ).resolves.toMatchObject({ kind: 'dead' });
    await expect(runRegistered(revoke, revokeExecutionFor(crypto.randomUUID()))).rejects.toThrow(
      /UPSTASH_REDIS_REST_URL\/TOKEN/
    );
  });

  // The dispatcher DO holds a Redis client, so a handler that ever reaches a
  // counter must find the bound already in force rather than an unbounded wait.
  // Reading the entry is what proves the wiring: an env whose value disagrees
  // with the one the process already settled can only be refused by a root that
  // read it.
  it('puts the counter bound in force from the dispatcher env', () => {
    expect(() =>
      openDispatcherRedis({
        ...env,
        RATE_LIMIT_REDIS_TIMEOUT_MS: String(rateLimitBound().timeoutMs + 1),
      })
    ).toThrow('RATE_LIMIT_REDIS_TIMEOUT_MS');
  });

  it('puts the counter identifier key in force from the dispatcher env', () => {
    expect(() =>
      openDispatcherRedis({
        ...env,
        RATE_LIMIT_KEY_SECRET: `${String(process.env['RATE_LIMIT_KEY_SECRET'])}-disagreeing`,
      })
    ).toThrow('RATE_LIMIT_KEY_SECRET');
  });

  it('registers and resolves admin.digest.v1 (the retention cron enqueues it — must not dead-letter as unknown)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(ADMIN_DIGEST_JOB_TYPE);
    const registered = registry.get(ADMIN_DIGEST_JOB_TYPE);
    expect(registered?.shard).toBe('bulk');
    expect(registered?.schema.safeParse({ day: '2026-07-13' }).success).toBe(true);
  });

  it('resolves the digest recipients from the live allowlist binding', async () => {
    // The production send wiring — env-selected sender plus the parsed
    // allowlist — rather than a hand-built double. The day is far outside any
    // fixture, so the audit read finds nothing and the outcome reports only
    // what the resolver produced.
    const registry = createDispatcherJobRegistry(
      {
        ...env,
        ADMIN_ACTOR_ALLOWLIST: 'ops@hushbox.ai',
        ADMIN_ROLE_MAP: 'ops@hushbox.ai=operator',
      },
      db
    );
    const digest = registry.get(ADMIN_DIGEST_JOB_TYPE);
    if (digest === undefined) throw new Error('admin.digest.v1 did not resolve');

    await expect(runRegistered(digest, executionWith({ day: '1991-01-01' }))).resolves.toEqual({
      kind: 'ok',
      result: { recipients: 1, day: '1991-01-01' },
    });
  });

  it('fails the digest send on a missing ADMIN_URL, naming the binding', async () => {
    const withoutAdminUrl: DispatcherEnv = {
      ...env,
      ADMIN_URL: '',
      ADMIN_ACTOR_ALLOWLIST: 'ops@hushbox.ai',
      ADMIN_ROLE_MAP: 'ops@hushbox.ai=operator',
    };
    const registry = createDispatcherJobRegistry(withoutAdminUrl, db);
    const digest = registry.get(ADMIN_DIGEST_JOB_TYPE);
    if (digest === undefined) throw new Error('admin.digest.v1 did not resolve');

    const day = isoAt(TEST_DAY_START).slice(0, 10);
    await expect(runRegistered(digest, executionWith({ day }))).rejects.toThrow(
      'ADMIN_URL is required to build admin audit links'
    );
  });

  it('registers and resolves growth.rollup.v1 (the hourly cron enqueues it — must not dead-letter as unknown)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(GROWTH_ROLLUP_JOB_TYPE);
    const registered = registry.get(GROWTH_ROLLUP_JOB_TYPE);
    expect(registered?.shard).toBe('bulk');
    expect(registered?.schema.safeParse({ hour: '2026-01-15T09' }).success).toBe(true);
  });

  it('runs the growth rollup on the dispatcher’s own counter client and clock', async () => {
    // An hour far outside the counting store's retention, so the answer does
    // not depend on what the rest of the suite left in a store every file
    // shares: no keys and no window left is the lost hour, which is the one
    // outcome that reaches an operator as a dead row. What it proves here is
    // the wiring — the handler resolving every dependency it runs on from the
    // dispatcher env — not the reduction, which the rollup's own tests settle.
    const registered = createDispatcherJobRegistry(env, db).get(GROWTH_ROLLUP_JOB_TYPE);
    if (registered === undefined) throw new Error('growth.rollup.v1 did not resolve');
    await expect(
      runRegistered(registered, executionWith({ hour: '1991-01-01T00' }))
    ).resolves.toEqual({
      kind: 'fail',
      error: GROWTH_ROLLUP_HOUR_LOST,
    });
  });

  it('still builds the growth rollup when the dispatcher Redis binding is absent', () => {
    // Its counter client is resolved inside the handler, so an absent binding
    // fails this type's rows and leaves the registry whole.
    const withoutRedis = { ...env, UPSTASH_REDIS_REST_URL: '' };
    expect(createDispatcherJobRegistry(withoutRedis, db).types()).toContain(GROWTH_ROLLUP_JOB_TYPE);
  });

  it('registers and resolves session.revoke.v1 (the webhook and admin ops enqueue it — must not dead-letter as unknown)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(SESSION_REVOKE_JOB_TYPE);
    const registered = registry.get(SESSION_REVOKE_JOB_TYPE);
    expect(registered).toBeDefined();
    expect(registered?.shard).toBe('bulk');
    expect(registered?.schema.safeParse({ userId: crypto.randomUUID() }).success).toBe(true);
  });

  it('resolves the row to its handler — dead-by-handler, never "unregistered job type"', async () => {
    // The registry built exactly as the DO composition builds it (job-dispatcher.ts).
    // Before the relocation the DO ran an empty registry, so this type resolved
    // to nothing and the executor dead-lettered it as "unregistered job type".
    // Through the adapter-composed registry it resolves to the payment-verify
    // handler, which dead-letters on the absent pre-claim row with ITS reason —
    // proving live resolution, not the unknown-type path. Invoking the handler
    // directly (rather than a shard-wide pass) keeps this test off the jobs
    // table entirely: it commits no jobs row, so there is nothing to clean up.
    const registered = createDispatcherJobRegistry(env, db).get(PAYMENT_VERIFY_JOB_TYPE);
    if (registered === undefined) throw new Error('payment.verify.v1 did not resolve');
    const outcome = await runRegistered(registered, executionFor(crypto.randomUUID()));
    expect(outcome).toEqual({ kind: 'dead', error: 'payment pre-claim row does not exist' });
  });

  it('binds the session-revoke handler to the realtime eviction fan-out when CONVERSATION_ROOM is present', async () => {
    const userId = crypto.randomUUID();
    const roomKey = REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId);
    createdKeys.push(roomKey, IDENTITY_KEYS.passwordChangedAt.buildKey(userId));
    await redis.sadd(roomKey, 'room-cb');

    const evicted: EvictCall[] = [];
    const envWithRoom = { ...env, CONVERSATION_ROOM: recordingNamespace(evicted) };
    const registered = createDispatcherJobRegistry(envWithRoom, db).get(SESSION_REVOKE_JOB_TYPE);
    if (registered === undefined) throw new Error('session.revoke.v1 did not resolve');

    const outcome = await runRegistered(registered, revokeExecutionFor(userId));

    expect(outcome).toEqual({ kind: 'ok', result: { revoked: userId } });
    // The handler bumped the watermark (revoke-all) and fanned the eviction out
    // to the user's active room through the realtime binding.
    expect(evicted).toEqual([{ conversationId: 'room-cb', principalId: userId }]);
  });

  it('completes the session-revoke handler when a room eviction is refused', async () => {
    const userId = crypto.randomUUID();
    const roomKey = REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId);
    createdKeys.push(roomKey, IDENTITY_KEYS.passwordChangedAt.buildKey(userId));
    await redis.sadd(roomKey, 'room-cb');

    const attempts: string[] = [];
    const envWithRoom = { ...env, CONVERSATION_ROOM: refusingNamespace(attempts) };
    const registered = createDispatcherJobRegistry(envWithRoom, db).get(SESSION_REVOKE_JOB_TYPE);
    if (registered === undefined) throw new Error('session.revoke.v1 did not resolve');

    const outcome = await runRegistered(registered, revokeExecutionFor(userId));

    // The room was reached and refused; revocation still reports success,
    // because eviction is only the promptness layer.
    expect(attempts).toEqual(['room-cb']);
    expect(outcome).toEqual({ kind: 'ok', result: { revoked: userId } });
  });

  it('runs the session-revoke handler with a no-op eviction when CONVERSATION_ROOM is absent', async () => {
    const userId = crypto.randomUUID();
    createdKeys.push(IDENTITY_KEYS.passwordChangedAt.buildKey(userId));
    const registered = createDispatcherJobRegistry(env, db).get(SESSION_REVOKE_JOB_TYPE);
    if (registered === undefined) throw new Error('session.revoke.v1 did not resolve');
    const outcome = await runRegistered(registered, revokeExecutionFor(userId));
    expect(outcome).toEqual({ kind: 'ok', result: { revoked: userId } });
  });
});
