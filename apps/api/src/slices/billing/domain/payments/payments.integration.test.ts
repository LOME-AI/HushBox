import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray, like } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  idempotencyKeys,
  jobs,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { ERROR_CODES, MAX_DEPOSIT_USD, NANO_USD_PER_CENT } from '@hushbox/shared';
import {
  createJobRegistry,
  createJobWakeCollector,
  grantJobWakes,
} from '../../../../lib/jobs/index.js';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { okAsync } from '../../../../lib/result/index.js';
import { createBillingStores } from '../../adapters/stores.js';
import { createMockPaymentProvider } from '../../adapters/payment-mock.js';
import { createHelcimPaymentProvider } from '../../adapters/payment-helcim.js';
import { createFixtureFetch } from '../../adapters/payment-helcim-fixtures.js';
import {
  PAYMENT_MAXIMUM_NANO_USD,
  PAYMENT_MINIMUM_NANO_USD,
  PAYMENT_VERIFY_DELAY_SECONDS,
  PAYMENT_VERIFY_JOB_TYPE,
  cardPaymentOutcomeOf,
  creditPaymentWithinTx,
  enqueuePaymentVerifyWithinTx,
  inFlightPaymentCutoff,
  initiateCardPayment,
  billingPrincipalUserId,
  paymentReference,
} from './payments.js';
import { createPaymentVerifyJobRegistration } from './payment-verify.js';
import { BILLING_KEYS } from '../keys.js';
// The operator's repair path is another slice's, so this test composes the
// registered admin operation itself: the property below is about what that
// op's real transition does to this slice's guard, which a stand-in for it
// could not show.
import { createAdminStores } from '../../../admin/adapters/stores.js';
import { createAdminOpEngine } from '../../../admin/domain/engine.js';
import { createAdminOpRegistry } from '../../../admin/domain/registry.js';
import { adminPaymentOperations } from '../../../admin/domain/operations/index.js';
import type { Principal } from '../../../../lib/context/index.js';
import type { JobOutcome } from '../../../../lib/jobs/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { MockPaymentProvider } from '../../adapters/payment-mock.js';
import type { BillingStores, PaymentStatus } from '../../ports/index.js';
import type { InitiateCardPaymentDeps } from './payments.js';
import type {
  AdminPaymentDeps,
  AdminPaymentPostDeps,
} from '../../../admin/domain/operations/payment.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL and UPSTASH_REDIS_* are required for billing payment integration tests'
  );
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
// A second pool, because `createDb` caps each at one connection: two pre-claims
// on `db` alone would queue for that connection rather than race for the lock
// the duplicate guard rests on.
const dbRival = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const stores = createBillingStores();
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([1, 2, 3]);
const WEBHOOK_VERIFIER = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
const createdUserIds: string[] = [];
// The admin engine's key rows and the wallet snapshots its post-commit effect
// writes: neither is reachable from the payment/user cleanup below.
const adminOpKeys: string[] = [];
const snapshotWalletIds: string[] = [];
let userCounter = 0;

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, captureError: noop };
}

function freshProvider(): MockPaymentProvider {
  return createMockPaymentProvider({
    webhookUrl: 'http://localhost:0/billing/webhooks/payment',
    webhookVerifier: WEBHOOK_VERIFIER,
    webhookDelayMs: 0,
    fetchImpl: () => Promise.resolve(new Response('ok')),
  });
}

function freshDeps(provider: MockPaymentProvider): InitiateCardPaymentDeps {
  const registry = createJobRegistry();
  registry.register(
    createPaymentVerifyJobRegistration({ db, stores, resolveProvider: () => provider })
  );
  return { db, stores, provider, registry };
}

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blpay${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@billing-payments.test`,
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

function chargeArgs(
  userId: string,
  overrides: Partial<Parameters<typeof initiateCardPayment>[1]> = {}
): Parameters<typeof initiateCardPayment>[1] {
  return {
    userId,
    amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
    cardToken: 'tok-1',
    customerCode: 'cust-1',
    ipAddress: '203.0.113.7',
    idempotencyKey: crypto.randomUUID(),
    now: new Date(),
    ...overrides,
  };
}

afterAll(async () => {
  await db.delete(jobs).where(like(jobs.dedupeKey, 'payment.verify:%'));
  if (adminOpKeys.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.key, adminOpKeys));
  }
  for (const walletId of snapshotWalletIds) {
    await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
  }
  if (createdUserIds.length > 0) {
    const paymentRows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(inArray(payments.userId, createdUserIds));
    const paymentIds = paymentRows.map((row) => row.id);
    if (paymentIds.length > 0) {
      const legRows = await db
        .select({ transactionId: ledgerEntries.transactionId })
        .from(ledgerEntries)
        .where(inArray(ledgerEntries.paymentId, paymentIds));
      const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
      if (transactionIds.length > 0) {
        await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
      }
      await db.delete(payments).where(inArray(payments.id, paymentIds));
    }
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await dbRival.$client.end();
  await db.$client.end();
});

describe('initiateCardPayment happy path', () => {
  it('pre-claims, charges with the payment id as the provider key, and awaits the webhook', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(deps, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('awaiting_webhook');
    expect(outcome.amountNanoUsd).toBe(PAYMENT_MINIMUM_NANO_USD);
    const requests = provider.getChargeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.idempotencyKey).toBe(outcome.paymentId);
    const row = await stores.readPayment(db, outcome.paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('awaiting_webhook');
    expect(row._unsafeUnwrap()?.helcimTransactionId).not.toBeNull();
    await provider.flushWebhooks();
  });

  it('charges with the payment id rendered as the merchant reference', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(deps, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    const requests = provider.getChargeRequests();
    expect(requests[0]?.reference).toBe(paymentReference(outcome.paymentId));
    await provider.flushWebhooks();
  });

  it('enqueues the delayed verify job in the pre-claim transaction', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const now = new Date();
    const result = await initiateCardPayment(deps, chargeArgs(userId, { now }));
    const outcome = result._unsafeUnwrap();
    const jobRows = await db
      .select({
        type: jobs.type,
        status: jobs.status,
        nextAttemptAt: jobs.nextAttemptAt,
        payload: jobs.payload,
      })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `payment.verify:${outcome.paymentId}`));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.type).toBe(PAYMENT_VERIFY_JOB_TYPE);
    expect(jobRows[0]?.status).toBe('pending');
    expect(jobRows[0]?.payload).toEqual({ paymentId: outcome.paymentId });
    const expectedAt = now.getTime() + PAYMENT_VERIFY_DELAY_SECONDS * 1000;
    expect(Math.abs((jobRows[0]?.nextAttemptAt.getTime() ?? 0) - expectedAt)).toBeLessThan(2000);
    await provider.flushWebhooks();
  });
});

describe('initiateCardPayment validation', () => {
  it('rejects an amount below the five dollar minimum', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(
      deps,
      chargeArgs(userId, { amountNanoUsd: PAYMENT_MINIMUM_NANO_USD - 10_000_000n })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(provider.getChargeRequests()).toHaveLength(0);
  });

  it('rejects an amount above the maximum, leaving no pre-claim row', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const aboveMaximum = BigInt(MAX_DEPOSIT_USD) * 100n * NANO_USD_PER_CENT + NANO_USD_PER_CENT;
    const result = await initiateCardPayment(
      deps,
      chargeArgs(userId, { amountNanoUsd: aboveMaximum })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(provider.getChargeRequests()).toHaveLength(0);
    const rows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('sets the maximum at one thousand dollars', () => {
    expect(PAYMENT_MAXIMUM_NANO_USD).toBe(1_000_000_000_000n);
  });

  it('accepts an amount at exactly the maximum', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(
      deps,
      chargeArgs(userId, { amountNanoUsd: PAYMENT_MAXIMUM_NANO_USD })
    );
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('awaiting_webhook');
    expect(outcome.amountNanoUsd).toBe(PAYMENT_MAXIMUM_NANO_USD);
    expect(provider.getChargeRequests()).toHaveLength(1);
    await provider.flushWebhooks();
  });

  it('rejects an amount that is not whole cents', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(
      deps,
      chargeArgs(userId, { amountNanoUsd: PAYMENT_MINIMUM_NANO_USD + 1n })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(provider.getChargeRequests()).toHaveLength(0);
  });
});

describe('initiateCardPayment decline', () => {
  it('records the decline on the pre-claim and reports failed', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    provider.setNextChargeOutcome({ status: 'declined', declineReason: 'insufficient funds' });
    const result = await initiateCardPayment(deps, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('failed');
    const row = await stores.readPayment(db, outcome.paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('failed');
    expect(row._unsafeUnwrap()?.errorCode).toBe('card_declined');
  });
});

describe('initiateCardPayment provider server error', () => {
  /**
   * The whole chain over the real provider adapter, because the defect this
   * pins lives at the seam between them: a server error is an unknown outcome,
   * so the pre-claim must stay `pending` for the reconcile job rather than
   * reaching the terminal `failed` a decline earns.
   */
  function helcimDeps(fixtureStatus: number, body: unknown): InitiateCardPaymentDeps {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(fixtureStatus, body);
    return {
      ...freshDeps(freshProvider()),
      provider: createHelcimPaymentProvider({
        apiToken: 'helcim-test-api-token',
        fetchImpl: fixture.fetchImpl,
        network: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, timeoutMs: 1000 },
      }),
    };
  }

  async function paymentStatusFor(userId: string): Promise<string | undefined> {
    const rows = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.userId, userId));
    return rows[0]?.status;
  }

  it('leaves the pre-claim pending when the provider answers a server error', async () => {
    const userId = await createUser();
    const result = await initiateCardPayment(
      helcimDeps(503, { responseMessage: 'Service unavailable' }),
      chargeArgs(userId)
    );

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    await expect(paymentStatusFor(userId)).resolves.toBe('pending');
  });

  it('still finalizes a genuine decline as failed', async () => {
    const userId = await createUser();
    const result = await initiateCardPayment(
      helcimDeps(400, { responseMessage: 'Insufficient funds' }),
      chargeArgs(userId)
    );

    expect(result._unsafeUnwrap().status).toBe('failed');
    await expect(paymentStatusFor(userId)).resolves.toBe('failed');
  });
});

describe('initiateCardPayment idempotency', () => {
  it('replays a finished payment without charging again', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const key = crypto.randomUUID();
    const first = await initiateCardPayment(deps, chargeArgs(userId, { idempotencyKey: key }));
    const second = await initiateCardPayment(deps, chargeArgs(userId, { idempotencyKey: key }));
    expect(second._unsafeUnwrap().paymentId).toBe(first._unsafeUnwrap().paymentId);
    expect(second._unsafeUnwrap().status).toBe('awaiting_webhook');
    expect(provider.getChargeRequests()).toHaveLength(1);
    await provider.flushWebhooks();
  });

  it('rejects the same key with a different amount', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const key = crypto.randomUUID();
    const first = await initiateCardPayment(deps, chargeArgs(userId, { idempotencyKey: key }));
    expect(first.isOk()).toBe(true);
    const mismatch = await initiateCardPayment(
      deps,
      chargeArgs(userId, { idempotencyKey: key, amountNanoUsd: PAYMENT_MINIMUM_NANO_USD * 2n })
    );
    expect(mismatch._unsafeUnwrapErr().code).toBe('conflict');
    await provider.flushWebhooks();
  });

  it('scopes the same client key to each user', async () => {
    const userA = await createUser();
    const userB = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const key = crypto.randomUUID();
    const first = await initiateCardPayment(deps, chargeArgs(userA, { idempotencyKey: key }));
    const second = await initiateCardPayment(deps, chargeArgs(userB, { idempotencyKey: key }));
    expect(first._unsafeUnwrap().paymentId).not.toBe(second._unsafeUnwrap().paymentId);
    await provider.flushWebhooks();
  });

  it('retries a crash between charge and finalize with the same provider key', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    let failFinalize = true;
    const crashingStores = {
      ...stores,
      markPaymentChargedWithinTx: async (
        ...parameters: Parameters<typeof stores.markPaymentChargedWithinTx>
      ) => {
        if (failFinalize) {
          failFinalize = false;
          throw new Error('process died before finalize');
        }
        return stores.markPaymentChargedWithinTx(...parameters);
      },
    };
    const key = crypto.randomUUID();
    const crashed = await initiateCardPayment(
      { ...deps, stores: crashingStores },
      chargeArgs(userId, { idempotencyKey: key })
    );
    expect(crashed._unsafeUnwrapErr().code).toBe('unavailable');
    const pendingRow = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.idempotencyKey, `pay:${userId}:${key}`));
    expect(pendingRow[0]?.status).toBe('pending');
    const retried = await initiateCardPayment(
      { ...deps, stores: crashingStores },
      chargeArgs(userId, { idempotencyKey: key })
    );
    expect(retried._unsafeUnwrap().status).toBe('awaiting_webhook');
    const requests = provider.getChargeRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.idempotencyKey).toBe(requests[1]?.idempotencyKey);
    await provider.flushWebhooks();
  });
});

describe('cardPaymentOutcomeOf', () => {
  it('treats a pending record as a defect', async () => {
    const userId = await createUser();
    const key = `pay:${userId}:${crypto.randomUUID()}`;
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: key,
      })
    );
    expect(() => cardPaymentOutcomeOf(payment)).toThrow(/pending/);
  });
});

describe('creditPaymentWithinTx', () => {
  it('credits the purchased wallet with a zero-sum deposit pair', async () => {
    const userId = await createUser();
    const key = `pay:${userId}:${crypto.randomUUID()}`;
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: key,
      })
    );
    await runSettlement(db, (tx) =>
      creditPaymentWithinTx(stores, tx, {
        paymentId: payment.id,
        userId,
        amountNanoUsd: payment.amountNanoUsd,
      })
    );
    const legs = await db
      .select({ amountNanoUsd: ledgerEntries.amountNanoUsd, kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, payment.id));
    expect(legs).toHaveLength(2);
    expect(legs.every((leg) => leg.kind === 'deposit')).toBe(true);
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    const walletRows = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(PAYMENT_MINIMUM_NANO_USD);
  });

  it('posts nothing more when this payment already carries its deposit pair', async () => {
    const userId = await createUser();
    const key = `pay:${userId}:${crypto.randomUUID()}`;
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: key,
      })
    );
    const credit = (): Promise<void> =>
      runSettlement(db, (tx) =>
        creditPaymentWithinTx(stores, tx, {
          paymentId: payment.id,
          userId,
          amountNanoUsd: payment.amountNanoUsd,
        })
      );
    await credit();

    await credit();

    const legs = await db
      .select({ amountNanoUsd: ledgerEntries.amountNanoUsd })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, payment.id));
    expect(legs).toHaveLength(2);
    const walletRows = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(PAYMENT_MINIMUM_NANO_USD);
  });
});

describe('enqueuePaymentVerifyWithinTx', () => {
  it('dedupes a second enqueue for the same payment', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const key = `pay:${userId}:${crypto.randomUUID()}`;
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: key,
      })
    );
    const now = new Date();
    const first = await runSettlement(db, (tx) =>
      enqueuePaymentVerifyWithinTx(tx, deps.registry, { paymentId: payment.id, now })
    );
    const second = await runSettlement(db, (tx) =>
      enqueuePaymentVerifyWithinTx(tx, deps.registry, { paymentId: payment.id, now })
    );
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
  });
});

describe('billingPrincipalUserId', () => {
  it('accepts the billing-portal credential', () => {
    const principal: Principal = {
      kind: 'billing-portal',
      credential: {
        credentialKind: 'billing-portal',
        userId: 'user-1',
        sessionId: 'c',
        createdAt: 0,
      },
    };
    expect(billingPrincipalUserId(principal)).toBe('user-1');
  });

  it('treats a sessionless principal as a composition defect', () => {
    expect(() => billingPrincipalUserId({ kind: 'none' })).toThrow(/without a session principal/);
  });
});

describe('initiateCardPayment failure mapping', () => {
  it('maps a failed pre-claim onto the unavailable channel', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const failingStores = {
      ...stores,
      insertPaymentIfAbsentWithinTx: () => {
        throw new Error('database down');
      },
    };
    const result = await initiateCardPayment(
      { ...deps, stores: failingStores },
      chargeArgs(userId)
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(provider.getChargeRequests()).toHaveLength(0);
  });

  it('records an approval that carries no card identifiers', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    provider.setNextChargeOutcome({
      status: 'approved',
      transactionId: `mock-txn-${crypto.randomUUID()}`,
    });
    const result = await initiateCardPayment(deps, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('awaiting_webhook');
    const row = await stores.readPayment(db, outcome.paymentId);
    expect(row._unsafeUnwrap()?.cardType).toBeNull();
    expect(row._unsafeUnwrap()?.cardLastFour).toBeNull();
    await provider.flushWebhooks();
  });

  it('replays the winner state when a concurrent retry finalized first', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const racingStores = {
      ...stores,
      markPaymentChargedWithinTx: async (
        ...parameters: Parameters<typeof stores.markPaymentChargedWithinTx>
      ) => {
        // The concurrent retry lands the transition; this caller observes 0 rows.
        await stores.markPaymentChargedWithinTx(...parameters);
        return false;
      },
    };
    const result = await initiateCardPayment({ ...deps, stores: racingStores }, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('awaiting_webhook');
    await provider.flushWebhooks();
  });

  it('treats a vanished pre-claim row during finalize as a defect', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const vanishedStores = {
      ...stores,
      markPaymentChargedWithinTx: () => Promise.resolve(false),
      readPayment: () => okAsync(null),
    };
    await expect(
      initiateCardPayment({ ...deps, stores: vanishedStores }, chargeArgs(userId))
    ).rejects.toThrow(/vanished/);
    await provider.flushWebhooks();
  });
});

describe('initiateCardPayment duplicate guard', () => {
  function fixtureDeps(status: number, body: unknown): InitiateCardPaymentDeps {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(status, body);
    return {
      ...freshDeps(freshProvider()),
      provider: createHelcimPaymentProvider({
        apiToken: 'helcim-test-api-token',
        fetchImpl: fixture.fetchImpl,
        network: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, timeoutMs: 1000 },
      }),
    };
  }

  async function seedAgedPayment(userId: string, status: PaymentStatus): Promise<string> {
    const cutoff = inFlightPaymentCutoff(new Date());
    const aged = new Date(cutoff.getTime() - 1000);
    const rows = await db
      .insert(payments)
      .values({
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
        status,
        helcimTransactionId: `billing-guard-${crypto.randomUUID()}`,
        createdAt: aged,
        // A row nobody has touched since it reached this status: `updatedAt` is
        // the same aged instant as `createdAt`. That faithfulness is all this
        // seed provides — the window's keying on `createdAt` rather than
        // transition time is pinned by the claw-back case, which moves
        // `updatedAt` to now.
        updatedAt: aged,
      })
      .returning({ id: payments.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('aged payment seed failed');
    return id;
  }

  async function seedFreshPayment(userId: string, status: PaymentStatus): Promise<void> {
    await db.insert(payments).values({
      userId,
      amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
      idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
      status,
    });
  }

  /** Releases every party only once all of them have reached it. */
  function meetingPoint(parties: number): () => Promise<void> {
    let arrived = 0;
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return () => {
      arrived += 1;
      if (arrived === parties) open();
      return gate;
    };
  }

  /** Holds the pre-claim inside its transaction, right after the row exists. */
  function gatedStores(arrive: () => Promise<void>): BillingStores {
    return {
      ...stores,
      insertPaymentIfAbsentWithinTx: async (
        ...parameters: Parameters<typeof stores.insertPaymentIfAbsentWithinTx>
      ) => {
        const claim = await stores.insertPaymentIfAbsentWithinTx(...parameters);
        await arrive();
        return claim;
      },
    };
  }

  function runVerify(paymentId: string, provider: MockPaymentProvider): Promise<JobOutcome> {
    return createPaymentVerifyJobRegistration({
      db,
      stores,
      resolveProvider: () => provider,
    }).handler({
      jobId: crypto.randomUUID(),
      payload: { paymentId },
      claims: 1,
      completeWithinTx: () => {
        throw new Error('payment.verify.v1 is not a txn-class job');
      },
    });
  }

  it('refuses a second deposit while the first awaits its webhook', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const first = await initiateCardPayment(deps, chargeArgs(userId));
    expect(first._unsafeUnwrap().status).toBe('awaiting_webhook');

    const second = await initiateCardPayment(deps, chargeArgs(userId));

    expect(second._unsafeUnwrapErr().wireCode).toBe(ERROR_CODES.PAYMENT_IN_FLIGHT);
    expect(provider.getChargeRequests()).toHaveLength(1);
    await provider.flushWebhooks();
  });

  it('admits exactly one of two concurrent deposits by the same user', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);

    // Both pre-claims are held at the point their rows exist and neither
    // transaction has committed, so the guard is exercised with two live
    // claims in flight rather than two calls that merely started together.
    const arrive = meetingPoint(2);
    const outcomes = await Promise.all([
      initiateCardPayment({ ...deps, stores: gatedStores(arrive) }, chargeArgs(userId)),
      initiateCardPayment(
        { ...deps, db: dbRival, stores: gatedStores(arrive) },
        chargeArgs(userId)
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.isOk())).toHaveLength(1);
    const refused = outcomes.filter((outcome) => outcome.isErr());
    expect(refused).toHaveLength(1);
    expect(refused[0]?._unsafeUnwrapErr().wireCode).toBe(ERROR_CODES.PAYMENT_IN_FLIGHT);
    expect(provider.getChargeRequests()).toHaveLength(1);
    // The refused pre-claim rolled back: a row left behind would itself block
    // the user for the whole guard window.
    const rows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.userId, userId));
    expect(rows).toHaveLength(1);
    await provider.flushWebhooks();
  });

  it('does not block a deposit by another user', async () => {
    const blocked = await createUser();
    const other = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    await seedFreshPayment(blocked, 'awaiting_webhook');

    const result = await initiateCardPayment(deps, chargeArgs(other));

    expect(result._unsafeUnwrap().status).toBe('awaiting_webhook');
    await provider.flushWebhooks();
  });

  it('stops blocking once the unresolved row ages past the guard window', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    await seedAgedPayment(userId, 'awaiting_webhook');

    const result = await initiateCardPayment(deps, chargeArgs(userId));

    expect(result._unsafeUnwrap().status).toBe('awaiting_webhook');
    await provider.flushWebhooks();
  });

  /**
   * The operator's claw back, run through the real admin engine — registry,
   * settlement transaction and audit row included, because the property is
   * about what that op's own transition does to this guard.
   */
  async function clawBack(paymentId: string, userId: string): Promise<void> {
    const key = crypto.randomUUID();
    adminOpKeys.push(key);
    const engine = createAdminOpEngine({
      db,
      registry: createAdminOpRegistry<AdminPaymentDeps, AdminPaymentPostDeps>([
        ...adminPaymentOperations,
      ]),
      stores: createAdminStores(),
      telemetry: noopTelemetry(),
      opDeps: { billingStores: stores },
      postDeps: { redis },
      executorId: `billing-guard-${crypto.randomUUID()}`,
    });

    const run = await engine.run({
      name: 'payment.uncompleteAndClawback',
      input: { paymentId, reason: 'the provider dashboard shows the capture reversed' },
      actor: `billing-guard-${crypto.randomUUID()}@hushbox.ai`,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: key,
    });
    run._unsafeUnwrap();
    const walletRows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    snapshotWalletIds.push(...walletRows.map((row) => row.id));
  }

  // The window is measured from the row's CREATION, so returning an aged row
  // to a non-terminal status does not re-block its payer: an operator repair
  // costs the user no deposit lockout. Keying the window on the transition
  // time instead would turn every such repair into one, silently.
  it('admits the next deposit after a claw back returns an aged row to awaiting_webhook', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const agedPaymentId = await seedAgedPayment(userId, 'completed');

    await clawBack(agedPaymentId, userId);

    const restored = await stores.readPayment(db, agedPaymentId);
    expect(restored._unsafeUnwrap()?.status).toBe('awaiting_webhook');
    const result = await initiateCardPayment(freshDeps(provider), chargeArgs(userId));
    expect(result._unsafeUnwrap().status).toBe('awaiting_webhook');
    await provider.flushWebhooks();
  });

  it.each(['completed', 'failed', 'expired'] as const)(
    'never blocks on a %s row',
    async (status) => {
      const userId = await createUser();
      const provider = freshProvider();
      const deps = freshDeps(provider);
      await seedFreshPayment(userId, status);

      const result = await initiateCardPayment(deps, chargeArgs(userId));

      expect(result._unsafeUnwrap().status).toBe('awaiting_webhook');
      await provider.flushWebhooks();
    }
  );

  it('blocks on the pending row a provider server error leaves behind', async () => {
    const userId = await createUser();
    const unknownOutcome = await initiateCardPayment(
      fixtureDeps(503, { responseMessage: 'Service unavailable' }),
      chargeArgs(userId)
    );
    expect(unknownOutcome._unsafeUnwrapErr().code).toBe('unavailable');

    const provider = freshProvider();
    const retry = await initiateCardPayment(freshDeps(provider), chargeArgs(userId));

    expect(retry._unsafeUnwrapErr().wireCode).toBe(ERROR_CODES.PAYMENT_IN_FLIGHT);
    expect(provider.getChargeRequests()).toHaveLength(0);
  });

  it('stops blocking once the verify job expires that pending row', async () => {
    const userId = await createUser();
    const unknownOutcome = await initiateCardPayment(
      fixtureDeps(503, { responseMessage: 'Service unavailable' }),
      chargeArgs(userId)
    );
    expect(unknownOutcome._unsafeUnwrapErr().code).toBe('unavailable');
    const stranded = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.userId, userId));
    const provider = freshProvider();
    // No capture at the provider for that reference: the reconciler expires it.
    const outcome = await runVerify(stranded[0]?.id ?? '', provider);
    expect(outcome.kind).toBe('ok');

    const retry = await initiateCardPayment(freshDeps(provider), chargeArgs(userId));

    expect(retry._unsafeUnwrap().status).toBe('awaiting_webhook');
    await provider.flushWebhooks();
  });
});
