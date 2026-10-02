import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  createDb,
  jobs,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { signHmacSha256Webhook } from '@hushbox/crypto';
import { createApp } from '../app.js';
import { runSettlement } from '../lib/idempotency/index.js';
import { createBillingStores, PAYMENT_MINIMUM_NANO_USD } from '../slices/billing/index.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

// The composition-root proof for the chargeback fix: a signed chargeback webhook
// against the fully ASSEMBLED `createApp()` must claw back, lock the account, and
// enqueue `session.revoke.v1` — which only succeeds if `app.ts` registered that
// job type on the webhook's enqueue registry. Without it the enqueue throws
// "unregistered job type", the clawback transaction rolls back, and the webhook
// 503-loops Helcim; this test would then see a non-200 and no job row.

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
// The composed pipeline runs CORS first; it fail-fasts on absent web origins.
const FRONTEND_URL = process.env['FRONTEND_URL'];
const MARKETING_URL = process.env['MARKETING_URL'];
const FRONTEND_PREVIEW_URL = process.env['FRONTEND_PREVIEW_URL'];
if (
  !DATABASE_URL ||
  !UPSTASH_REDIS_REST_URL ||
  !UPSTASH_REDIS_REST_TOKEN ||
  !FRONTEND_URL ||
  !MARKETING_URL ||
  !FRONTEND_PREVIEW_URL
) {
  throw new Error('DATABASE_URL, UPSTASH_REDIS_*, and web-origin vars are required');
}

const SECRET = 'secret-at-least-32-characters-long!!';
const WEBHOOK_VERIFIER = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
type WebhookEnv = Bindings &
  TelemetryEnv & {
    HELCIM_WEBHOOK_VERIFIER: string;
    API_URL: string;
    FRONTEND_URL: string;
    MARKETING_URL: string;
    FRONTEND_PREVIEW_URL: string;
  };

// API_URL + HELCIM_WEBHOOK_VERIFIER let the assembled app build its local payment
// mock (constructed inside the enqueue registry factory); the mock is never
// invoked here — payments are seeded directly and webhooks posted by hand.
const webhookEnv: WebhookEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
  HELCIM_WEBHOOK_VERIFIER: WEBHOOK_VERIFIER,
  API_URL: 'http://localhost',
  FRONTEND_URL,
  MARKETING_URL,
  FRONTEND_PREVIEW_URL,
};

const db: Database = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([9, 9, 9]);
const createdUserIds: string[] = [];
const createdPaymentIds: string[] = [];

/**
 * `webhookEnv` plus a dispatcher binding recording the shard each nudge
 * addressed, newest last. `createApp()` is the only place the real composition
 * wires the enqueue registries this webhook needs, so this is where a wake
 * proves it survives assembly rather than only the slice's own manifest.
 *
 * One recorder per test, never a shared one: a teardown handed to `waitUntil`
 * discharges its wake at a moment no test pins, so a shared array would let one
 * test's nudge land inside another test's assertion.
 */
function recordingDispatcherEnv(): { env: WebhookEnv; wokenShards: string[] } {
  const wokenShards: string[] = [];
  const env: WebhookEnv = {
    ...webhookEnv,
    JOB_DISPATCHER: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: (): Promise<Response> => {
          wokenShards.push(String(id));
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      }),
    },
  };
  return { env, wokenShards };
}

/**
 * An ExecutionContext double so the pipeline hands its teardown to `waitUntil`
 * instead of awaiting it inline. That teardown drains the request's side-bands
 * and then discharges the wakes its committed transactions collected, so a
 * test that wants either must await the collected tasks.
 */
function recordingExecutionCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task);
    },
    passThroughOnException: () => {
      /* no-op in tests */
    },
    props: {},
  };
  return { ctx, tasks };
}

async function seedUser(): Promise<string> {
  const username = `cbk${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@chargeback-mount.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedChargedPayment(
  userId: string
): Promise<{ paymentId: string; transactionId: string }> {
  const { payment } = await runSettlement(db, (tx) =>
    stores.insertPaymentIfAbsentWithinTx(tx, {
      userId,
      amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
      idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
    })
  );
  createdPaymentIds.push(payment.id);
  const transactionId = `txn-${crypto.randomUUID()}`;
  await runSettlement(db, (tx) =>
    stores.markPaymentChargedWithinTx(tx, payment.id, { helcimTransactionId: transactionId })
  );
  return { paymentId: payment.id, transactionId };
}

async function signedWebhook(
  payload: string,
  ctx: ExecutionContext,
  env: WebhookEnv
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookId = `wh-${crypto.randomUUID()}`;
  const signature = await signHmacSha256Webhook({
    secret: WEBHOOK_VERIFIER,
    payload,
    timestamp,
    webhookId,
  });
  return createApp().request(
    '/billing/webhooks/payment',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-signature': signature,
        'webhook-timestamp': timestamp,
        'webhook-id': webhookId,
      },
      body: payload,
    },
    env,
    ctx
  );
}

afterAll(async () => {
  for (const paymentId of createdPaymentIds) {
    await db
      .delete(jobs)
      .where(
        inArray(jobs.dedupeKey, [`chargeback-revoke:${paymentId}`, `payment.verify:${paymentId}`])
      );
    const legRows = await db
      .select({ transactionId: ledgerEntries.transactionId })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
    if (transactionIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
    }
    await db.delete(payments).where(eq(payments.id, paymentId));
  }
  if (createdUserIds.length > 0) {
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(allowanceSpending).where(inArray(allowanceSpending.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('createApp: a chargeback webhook claws back, locks, and enqueues the revoke job', () => {
  it('enqueues session.revoke.v1 and commits the clawback + lock', async () => {
    const userId = await seedUser();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    const { ctx, tasks } = recordingExecutionCtx();
    const { env } = recordingDispatcherEnv();

    const captured = await signedWebhook(
      JSON.stringify({ type: 'cardTransaction', id: transactionId }),
      ctx,
      env
    );
    expect(captured.status).toBe(200);

    const dispute = await signedWebhook(
      JSON.stringify({ type: 'chargeback', id: transactionId }),
      ctx,
      env
    );
    // A 503 here is the exact "unregistered job type" failure the wiring fixes.
    expect(dispute.status).toBe(200);

    const lockedRows = await db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, userId));
    expect(lockedRows[0]?.lockedAt).not.toBeNull();

    const revokeJobs = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `chargeback-revoke:${paymentId}`));
    expect(revokeJobs).toHaveLength(1);
    expect(revokeJobs[0]?.type).toBe('session.revoke.v1');

    const legs = await db
      .select({ kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs.filter((leg) => leg.kind === 'clawback')).toHaveLength(2);
    // Nothing outlives the test: an undrained teardown discharges its wake and
    // closes the request's own Neon pool after the test that spawned it ended.
    await Promise.all(tasks);
  });

  it('nudges the bulk dispatcher once the assembled pipeline tears the request down', async () => {
    const userId = await seedUser();
    const { transactionId } = await seedChargedPayment(userId);
    const { ctx, tasks } = recordingExecutionCtx();
    const { env, wokenShards } = recordingDispatcherEnv();

    await signedWebhook(JSON.stringify({ type: 'cardTransaction', id: transactionId }), ctx, env);
    await signedWebhook(JSON.stringify({ type: 'chargeback', id: transactionId }), ctx, env);
    // The teardown the pipeline hands to `waitUntil` is what turns the
    // enqueue's collected shard into a nudge, so it must drain first.
    await Promise.all(tasks);

    expect(wokenShards).toEqual(['bulk']);
  });
});
