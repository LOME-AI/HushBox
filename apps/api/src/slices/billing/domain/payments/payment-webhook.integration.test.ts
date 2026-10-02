import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  jobs,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import {
  createJobRegistry,
  createJobWakeCollector,
  grantJobWakes,
} from '../../../../lib/jobs/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { createSessionRevokeJobRegistration } from '../../../identity/index.js';
import { createBillingStores } from '../../adapters/stores.js';
import { PAYMENT_MINIMUM_NANO_USD } from './payments.js';
import { applyPaymentWebhookEvent } from './payment-webhook.js';
import type { JobRegistry, JobShard } from '../../../../lib/jobs/index.js';
import type {
  AccountDefensePort,
  BillingStores,
  ChargebackLockEmailPort,
} from '../../ports/index.js';
import type { PaymentWebhookDeps } from './payment-webhook.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for payment webhook integration tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
// A second pool, because `createDb` caps each at one connection. On a single
// pool the first delivery's open settlement transaction holds that connection
// while it waits at the meeting point, so the second can never acquire one to
// arrive: the gate never opens and this test deadlocks until it times out.
// Removing `dbRival` does not serialize the two deliveries; it hangs them.
const dbRival = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const stores = createBillingStores();

interface ActedWithWakes<T> {
  readonly result: T;
  readonly wakes: readonly JobShard[];
}

/**
 * Runs one act and reports the shards it left on the shared handle. A fresh
 * collector per act: re-granting REPLACES the collector, which is the per-act
 * isolation wanted here and is exactly why a production boundary keeps its
 * mint and its discharge in one scope instead.
 */
async function actWithWakes<T>(act: () => PromiseLike<T>): Promise<ActedWithWakes<T>> {
  const collector = createJobWakeCollector();
  grantJobWakes(db, collector);
  const result = await act();
  return { result, wakes: collector.shards() };
}
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdPaymentIds: string[] = [];
let userCounter = 0;

interface DefenseRecorder {
  readonly port: AccountDefensePort;
  readonly locks: string[];
  alreadyLocked: boolean;
}

function recordingDefense(
  email: string | null = 'victim@example.test',
  userName: string | null = 'victim'
): DefenseRecorder {
  const recorder: DefenseRecorder = {
    locks: [],
    alreadyLocked: false,
    port: {
      lockForChargebackWithinTx: (_tx, userId) => {
        recorder.locks.push(userId);
        const locked = !recorder.alreadyLocked;
        recorder.alreadyLocked = true;
        // The real store returns a null email and username on the no-op path;
        // the webhook only sends the lock email on a fresh transition.
        return Promise.resolve({
          locked,
          email: locked ? email : null,
          userName: locked ? userName : null,
        });
      },
    },
  };
  return recorder;
}

// A registry carrying only the session.revoke.v1 registration, for the
// in-tx enqueue. The handler never runs here (only the enqueue), so an
// unreachable Redis backs it — the enqueue reads the schema/shard/lease only.
function revokeRegistry(): JobRegistry {
  const registry = createJobRegistry();
  registry.register(
    createSessionRevokeJobRegistration({
      resolveRevoke: () => ({
        redis: new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false }),
      }),
    })
  );
  return registry;
}

type ChargebackLockEmailArgs = Parameters<ChargebackLockEmailPort['sendChargebackLockEmail']>[0];

function recordingEmail(): { port: ChargebackLockEmailPort; sent: ChargebackLockEmailArgs[] } {
  const sent: ChargebackLockEmailArgs[] = [];
  return {
    sent,
    port: {
      sendChargebackLockEmail: (args) => {
        sent.push(args);
        return okAsync();
      },
    },
  };
}

function deps(
  defense: AccountDefensePort = recordingDefense().port,
  email: ChargebackLockEmailPort = recordingEmail().port
): PaymentWebhookDeps {
  return {
    db,
    stores,
    accountDefense: defense,
    accountLockedEmail: email,
    registry: revokeRegistry(),
  };
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

/** Holds each delivery inside its settlement transaction, before it claims. */
function gatedStores(arrive: () => Promise<void>): BillingStores {
  return {
    ...stores,
    claimPaymentCompletedWithinTx: async (
      ...parameters: Parameters<typeof stores.claimPaymentCompletedWithinTx>
    ) => {
      await arrive();
      return stores.claimPaymentCompletedWithinTx(...parameters);
    },
  };
}

async function revokeJobsForPayment(
  paymentId: string
): Promise<{ shard: string; payload: unknown }[]> {
  return db
    .select({ shard: jobs.shard, payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.dedupeKey, `chargeback-revoke:${paymentId}`));
}

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blwh${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@payment-webhook.test`,
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

async function seedCompletedPayment(
  userId: string
): Promise<{ paymentId: string; transactionId: string }> {
  const seeded = await seedChargedPayment(userId);
  const application = await applyPaymentWebhookEvent(deps(), {
    type: 'payment.completed',
    transactionId: seeded.transactionId,
  });
  expect(application._unsafeUnwrap().disposition.kind).toBe('credited');
  return seeded;
}

async function legsFor(paymentId: string): Promise<{ kind: string; amountNanoUsd: bigint }[]> {
  return db
    .select({ kind: ledgerEntries.kind, amountNanoUsd: ledgerEntries.amountNanoUsd })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.paymentId, paymentId));
}

async function balanceOf(userId: string): Promise<bigint | undefined> {
  const rows = await db
    .select({ balanceNanoUsd: wallets.balanceNanoUsd })
    .from(wallets)
    .where(eq(wallets.userId, userId));
  return rows[0]?.balanceNanoUsd;
}

afterAll(async () => {
  if (createdPaymentIds.length > 0) {
    // The dispute tests commit session.revoke.v1 rows (bulk shard); clear
    // them so they never linger claimable on the shared jobs table.
    await db.delete(jobs).where(
      inArray(
        jobs.dedupeKey,
        createdPaymentIds.map((id) => `chargeback-revoke:${id}`)
      )
    );
  }
  if (createdUserIds.length > 0) {
    const paymentIds = [...createdPaymentIds];
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

describe('payment.completed finalization', () => {
  it('claims the pre-claim and credits the wallet through the ledger', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    const application = await applyPaymentWebhookEvent(deps(), {
      type: 'payment.completed',
      transactionId,
    });
    const value = application._unsafeUnwrap();
    expect(value.claimed).toBe(true);
    expect(value.disposition).toEqual({ kind: 'credited', paymentId });
    expect(await balanceOf(userId)).toBe(PAYMENT_MINIMUM_NANO_USD);
    const legs = await legsFor(paymentId);
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
  });

  it('treats a duplicate delivery as a no-op', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedCompletedPayment(userId);
    const duplicate = await applyPaymentWebhookEvent(deps(), {
      type: 'payment.completed',
      transactionId,
    });
    const value = duplicate._unsafeUnwrap();
    expect(value.claimed).toBe(false);
    expect(value.disposition).toEqual({ kind: 'already-completed', paymentId });
    expect(await legsFor(paymentId)).toHaveLength(2);
  });

  it('credits exactly once under concurrent duplicate deliveries', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    const event = { type: 'payment.completed' as const, transactionId };

    // Both deliveries are held with their settlement transactions open and
    // neither holding the payments row lock, so the release puts two live
    // claims in flight rather than two calls that merely started together.
    // Gating AFTER either claim would deadlock instead: the second delivery
    // would block on the first's row lock and never reach the meeting point.
    const arrive = meetingPoint(2);
    const outcomes = await Promise.all([
      applyPaymentWebhookEvent({ ...deps(), stores: gatedStores(arrive) }, event),
      applyPaymentWebhookEvent({ ...deps(), db: dbRival, stores: gatedStores(arrive) }, event),
    ]);

    const values = outcomes.map((outcome) => outcome._unsafeUnwrap());
    expect(values.filter((value) => value.claimed)).toHaveLength(1);
    expect(values).toContainEqual(
      expect.objectContaining({ disposition: { kind: 'credited', paymentId } })
    );
    // The loser reads the winner's committed row rather than crediting again.
    expect(values).toContainEqual(
      expect.objectContaining({ disposition: { kind: 'already-completed', paymentId } })
    );
    expect(await legsFor(paymentId)).toHaveLength(2);
    expect(await balanceOf(userId)).toBe(PAYMENT_MINIMUM_NANO_USD);
  });

  it('reports an unmatched transaction for provider redelivery', async () => {
    const application = await applyPaymentWebhookEvent(deps(), {
      type: 'payment.completed',
      transactionId: `txn-${crypto.randomUUID()}`,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({ kind: 'unmatched' });
  });

  it('completes without crediting when the user was hard-deleted', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    await db.update(payments).set({ userId: null }).where(eq(payments.id, paymentId));
    const application = await applyPaymentWebhookEvent(deps(), {
      type: 'payment.completed',
      transactionId,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({
      kind: 'completed-without-wallet',
      paymentId,
    });
    expect(await legsFor(paymentId)).toHaveLength(0);
  });
});

describe('payment.failed finalization', () => {
  it('records a decline the provider reports after the charge', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    const application = await applyPaymentWebhookEvent(deps(), {
      type: 'payment.failed',
      transactionId,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({
      kind: 'decline-recorded',
      paymentId,
    });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('failed');
  });

  it('no-ops a decline for an unknown transaction', async () => {
    const application = await applyPaymentWebhookEvent(deps(), {
      type: 'payment.failed',
      transactionId: `txn-${crypto.randomUUID()}`,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({ kind: 'decline-unmatched' });
  });
});

describe('dispute chargeback and reversal', () => {
  it('posts the clawback pair once and locks the account', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedCompletedPayment(userId);
    const defense = recordingDefense();
    const email = recordingEmail();
    const application = await applyPaymentWebhookEvent(deps(defense.port, email.port), {
      type: 'dispute.chargeback',
      transactionId,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({
      kind: 'clawback-posted',
      paymentId,
    });
    expect(defense.locks).toEqual([userId]);
    expect(email.sent).toHaveLength(1);
    expect(await balanceOf(userId)).toBe(0n);
    const legs = await legsFor(paymentId);
    expect(legs.filter((leg) => leg.kind === 'clawback')).toHaveLength(2);
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
  });

  it('sends the lock email to the locked account by its name', async () => {
    const userId = await createUser();
    const { transactionId } = await seedCompletedPayment(userId);
    const email = recordingEmail();
    const application = await applyPaymentWebhookEvent(
      deps(recordingDefense('alice@example.test', 'Alice').port, email.port),
      {
        type: 'dispute.chargeback',
        transactionId,
      }
    );
    expect(application._unsafeUnwrap().disposition.kind).toBe('clawback-posted');
    expect(email.sent).toEqual([{ to: 'alice@example.test', userName: 'Alice' }]);
  });

  it('sends the lock email with no name when the lock captured none', async () => {
    const userId = await createUser();
    const { transactionId } = await seedCompletedPayment(userId);
    const email = recordingEmail();
    const application = await applyPaymentWebhookEvent(
      deps(recordingDefense('alice@example.test', null).port, email.port),
      {
        type: 'dispute.chargeback',
        transactionId,
      }
    );
    expect(application._unsafeUnwrap().disposition.kind).toBe('clawback-posted');
    expect(email.sent).toEqual([{ to: 'alice@example.test' }]);
  });

  it('debits the ledger exactly once across duplicate dispute deliveries', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedCompletedPayment(userId);
    const defense = recordingDefense();
    const email = recordingEmail();
    const webhookDeps = deps(defense.port, email.port);
    const first = await applyPaymentWebhookEvent(webhookDeps, {
      type: 'dispute.chargeback',
      transactionId,
    });
    const second = await applyPaymentWebhookEvent(webhookDeps, {
      type: 'dispute.reversal',
      transactionId,
    });
    expect(first._unsafeUnwrap().disposition.kind).toBe('clawback-posted');
    expect(second._unsafeUnwrap().disposition.kind).toBe('clawback-duplicate');
    const legs = await legsFor(paymentId);
    expect(legs.filter((leg) => leg.kind === 'clawback')).toHaveLength(2);
    // The duplicate clawback means the dispute was already applied, so the
    // lock and email fire only on the first delivery — a redelivery re-runs
    // no side effect.
    expect(defense.locks).toEqual([userId]);
    expect(email.sent).toHaveLength(1);
  });

  it('does not re-lock or re-email when a dispute is replayed after an admin unlock', async () => {
    const userId = await createUser();
    const { transactionId } = await seedCompletedPayment(userId);
    const defense = recordingDefense();
    const email = recordingEmail();
    const webhookDeps = deps(defense.port, email.port);
    const first = await applyPaymentWebhookEvent(webhookDeps, {
      type: 'dispute.chargeback',
      transactionId,
    });
    expect(first._unsafeUnwrap().disposition.kind).toBe('clawback-posted');
    // An admin lifts the lock; a later redelivery of the same dispute must not
    // re-lock the genuine victim now that the clawback pair already posted.
    defense.alreadyLocked = false;
    const replay = await applyPaymentWebhookEvent(webhookDeps, {
      type: 'dispute.reversal',
      transactionId,
    });
    expect(replay._unsafeUnwrap().disposition.kind).toBe('clawback-duplicate');
    expect(defense.locks).toEqual([userId]);
    expect(email.sent).toHaveLength(1);
  });

  it('neither locks nor emails on a dispute for a payment that never completed', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    const defense = recordingDefense();
    const email = recordingEmail();
    const application = await applyPaymentWebhookEvent(deps(defense.port, email.port), {
      type: 'dispute.chargeback',
      transactionId,
    });
    // No captured funds means no fraud exposure: the dispute is surfaced for
    // observability (notify-only) but the account is never locked or emailed.
    expect(application._unsafeUnwrap().disposition).toEqual({ kind: 'notify-only' });
    expect(defense.locks).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(await legsFor(paymentId)).toHaveLength(0);
  });

  it('surfaces a failed lock so the provider redelivers the dispute', async () => {
    const userId = await createUser();
    const { transactionId } = await seedCompletedPayment(userId);
    const failingDefense: AccountDefensePort = {
      lockForChargebackWithinTx: () => Promise.reject(new Error('identity down')),
    };
    const application = await applyPaymentWebhookEvent(deps(failingDefense), {
      type: 'dispute.chargeback',
      transactionId,
    });
    expect(application._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('never blocks the dispute on a failed lock email', async () => {
    const userId = await createUser();
    const { transactionId } = await seedCompletedPayment(userId);
    const failingEmail: ChargebackLockEmailPort = {
      sendChargebackLockEmail: () => errAsync(unavailableError('sender down')),
    };
    const application = await applyPaymentWebhookEvent(
      deps(recordingDefense().port, failingEmail),
      { type: 'dispute.chargeback', transactionId }
    );
    expect(application._unsafeUnwrap().disposition.kind).toBe('clawback-posted');
  });

  it('reports an unmatched dispute without locking anyone', async () => {
    const defense = recordingDefense();
    const application = await applyPaymentWebhookEvent(deps(defense.port), {
      type: 'dispute.chargeback',
      transactionId: `txn-${crypto.randomUUID()}`,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({ kind: 'dispute-unmatched' });
    expect(defense.locks).toHaveLength(0);
  });

  it('reports an orphaned dispute for a hard-deleted user', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedCompletedPayment(userId);
    await db.update(payments).set({ userId: null }).where(eq(payments.id, paymentId));
    const defense = recordingDefense();
    const application = await applyPaymentWebhookEvent(deps(defense.port), {
      type: 'dispute.chargeback',
      transactionId,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({
      kind: 'dispute-orphaned',
      paymentId,
    });
    expect(defense.locks).toHaveLength(0);
  });

  it('enqueues the must-happen revoke job atomically with the clawback and leaves its wake', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedCompletedPayment(userId);
    const { result, wakes } = await actWithWakes(() =>
      applyPaymentWebhookEvent(deps(recordingDefense().port), {
        type: 'dispute.chargeback',
        transactionId,
      })
    );
    expect(result._unsafeUnwrap().disposition.kind).toBe('clawback-posted');
    // The enqueue leaves the bulk shard on the handle the boundary discharges.
    expect(wakes).toEqual(['bulk']);
    const revokeJobs = await revokeJobsForPayment(paymentId);
    expect(revokeJobs).toHaveLength(1);
    expect(revokeJobs[0]?.shard).toBe('bulk');
    expect(revokeJobs[0]?.payload).toEqual({ userId });
  });

  it('does not double-enqueue the revoke job or leave a second wake on a duplicate delivery', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedCompletedPayment(userId);
    const webhookDeps = deps(recordingDefense().port);
    const first = await actWithWakes(() =>
      applyPaymentWebhookEvent(webhookDeps, { type: 'dispute.chargeback', transactionId })
    );
    const second = await actWithWakes(() =>
      applyPaymentWebhookEvent(webhookDeps, { type: 'dispute.reversal', transactionId })
    );
    expect(first.wakes).toEqual(['bulk']);
    // The per-payment dedupe key means the redelivery enqueues nothing, so it
    // leaves no shard for the boundary to nudge.
    expect(second.wakes).toEqual([]);
    expect(await revokeJobsForPayment(paymentId)).toHaveLength(1);
  });

  it('rolls back BOTH the clawback and the revoke enqueue when the in-tx lock fails, then commits both on retry', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedCompletedPayment(userId);
    let attempts = 0;
    // The lock throws on the first delivery and succeeds on the retry — proving
    // the clawback legs and the revoke enqueue share the lock's transaction.
    const flakyDefense: AccountDefensePort = {
      lockForChargebackWithinTx: (_tx, id) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('identity down'));
        return Promise.resolve({ locked: true, email: `${id}@retry.test`, userName: 'retry' });
      },
    };
    const webhookDeps = deps(flakyDefense);

    const failed = await applyPaymentWebhookEvent(webhookDeps, {
      type: 'dispute.chargeback',
      transactionId,
    });
    expect(failed._unsafeUnwrapErr().code).toBe('unavailable');
    // Nothing partial committed: no clawback legs, the credit balance stands,
    // and no revoke job was enqueued.
    const rolledBackLegs = await legsFor(paymentId);
    expect(rolledBackLegs.filter((leg) => leg.kind === 'clawback')).toHaveLength(0);
    expect(await balanceOf(userId)).toBe(PAYMENT_MINIMUM_NANO_USD);
    expect(await revokeJobsForPayment(paymentId)).toHaveLength(0);

    const retried = await applyPaymentWebhookEvent(webhookDeps, {
      type: 'dispute.chargeback',
      transactionId,
    });
    expect(retried._unsafeUnwrap().disposition.kind).toBe('clawback-posted');
    const committedLegs = await legsFor(paymentId);
    expect(committedLegs.filter((leg) => leg.kind === 'clawback')).toHaveLength(2);
    expect(await balanceOf(userId)).toBe(0n);
    expect(await revokeJobsForPayment(paymentId)).toHaveLength(1);
  });
});

describe('inquiries, retrievals, and unknown events', () => {
  it('only notifies on an inquiry', async () => {
    const userId = await createUser();
    const { paymentId, transactionId } = await seedCompletedPayment(userId);
    const defense = recordingDefense();
    const application = await applyPaymentWebhookEvent(deps(defense.port), {
      type: 'dispute.inquiry',
      transactionId,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({ kind: 'notify-only' });
    expect(defense.locks).toHaveLength(0);
    expect(await legsFor(paymentId)).toHaveLength(2);
  });

  it('only notifies on a retrieval', async () => {
    const userId = await createUser();
    const { transactionId } = await seedCompletedPayment(userId);
    const defense = recordingDefense();
    const application = await applyPaymentWebhookEvent(deps(defense.port), {
      type: 'dispute.retrieval',
      transactionId,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({ kind: 'notify-only' });
    expect(defense.locks).toHaveLength(0);
  });

  it('ignores an unrecognized event type without crashing', async () => {
    const application = await applyPaymentWebhookEvent(deps(), {
      type: 'unrecognized',
      rawType: 'somethingNew',
    });
    expect(application._unsafeUnwrap().disposition).toEqual({ kind: 'ignored' });
  });
});

describe('settlement failure mapping', () => {
  it('maps a failed credit settlement onto the unavailable channel', async () => {
    const userId = await createUser();
    const { transactionId } = await seedChargedPayment(userId);
    const failingStores = {
      ...stores,
      claimPaymentCompletedWithinTx: () => {
        throw new Error('database down');
      },
    };
    const application = await applyPaymentWebhookEvent(
      { ...deps(), stores: failingStores },
      { type: 'payment.completed', transactionId }
    );
    expect(application._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a failed decline settlement onto the unavailable channel', async () => {
    const userId = await createUser();
    const { transactionId } = await seedChargedPayment(userId);
    const failingStores = {
      ...stores,
      markPaymentFailedWithinTx: () => {
        throw new Error('database down');
      },
    };
    const application = await applyPaymentWebhookEvent(
      { ...deps(), stores: failingStores },
      { type: 'payment.failed', transactionId }
    );
    expect(application._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a failed clawback settlement onto the unavailable channel', async () => {
    const userId = await createUser();
    const { transactionId } = await seedCompletedPayment(userId);
    const failingStores = {
      ...stores,
      insertLedgerLegsIfAbsentWithinTx: () => {
        throw new Error('database down');
      },
    };
    const application = await applyPaymentWebhookEvent(
      { ...deps(), stores: failingStores },
      { type: 'dispute.chargeback', transactionId }
    );
    expect(application._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('no-ops a decline for a payment that already completed', async () => {
    const userId = await createUser();
    const { transactionId } = await seedCompletedPayment(userId);
    const application = await applyPaymentWebhookEvent(deps(), {
      type: 'payment.failed',
      transactionId,
    });
    expect(application._unsafeUnwrap().disposition).toEqual({ kind: 'decline-unmatched' });
  });
});
