import { Redis } from '@upstash/redis';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory, walletFactory } from '@hushbox/db/factories';
import { ADMIN_OP_CONTRACTS, ERROR_CODES, PAYMENT_STATUSES } from '@hushbox/shared';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import {
  applyPaymentWebhookEvent,
  createBillingStores,
  runConservationAudit,
} from '../../../billing/index.js';
import { BILLING_KEYS } from '../../../billing/domain/keys.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { withUndoReason } from '../undo-round-trip.js';
import { adminPaymentOperations } from './index.js';
import { createJobWakeCollector, grantJobWakes } from '../../../../lib/jobs/index.js';
import type { LedgerLegInput, PaymentStatus } from '../../../billing/index.js';
import type { Variables } from '../../../../lib/context/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks, AdminOpRunResult } from '../engine.js';
import type {
  AdminOpHarnessInstance,
  AdminOpInterleavingAction,
  AdminOpInterleavingConfig,
  SeededRng,
} from '../describe-admin-op.js';
import type { AdminPaymentDeps, AdminPaymentPostDeps } from './payment.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Redis env are required for admin payment op tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
// A second pool, because `createDb` caps each at one connection: two
// operations on one handle serialize, which would prove nothing about a race.
const dbRival = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const billingStores = createBillingStores();
const adminStores = createAdminStores();

const FORCE_EXPIRE_CONTRACT = ADMIN_OP_CONTRACTS['payment.forceExpire'];
const RESTORE_CONTRACT = ADMIN_OP_CONTRACTS['payment.restoreAwaitingWebhook'];
const COMPLETE_CONTRACT = ADMIN_OP_CONTRACTS['payment.forceCompleteAndCredit'];
const UNCOMPLETE_CONTRACT = ADMIN_OP_CONTRACTS['payment.uncompleteAndClawback'];

/** $4 in nano-USD — the amount every seeded pre-claim captured. */
const PAYMENT_AMOUNT_NANO_USD = 4_000_000_000n;

const snapshotWalletIds: string[] = [];

afterAll(async () => {
  // admin_audit is append-only by trigger and the ledger/wallet rows stay
  // (balanced, uuid-isolated); only the engine-claim key rows and the Redis
  // snapshot keys are removed.
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/payment.%'));
  for (const walletId of snapshotWalletIds) {
    await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
  }
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, captureError: noop };
}

interface SnapshotProbeState {
  readonly log: string[];
  armed: boolean;
}

/**
 * The battery's ephemeral seam: a narrow Redis facade that delegates the
 * snapshot CAS script to the real client while recording each landed write
 * and honoring the armed-failure probe. Cast is safe — `writeThroughSnapshot`
 * touches only `createScript(...).exec(...)`.
 */
function probeRedis(state: SnapshotProbeState): Variables['redis'] {
  const facade = {
    createScript: (script: string) => ({
      exec: async (keys: string[], args: string[]): Promise<unknown> => {
        if (state.armed) throw new Error('snapshot probe armed to fail');
        const result = await redis.createScript(script).exec(keys, args);
        state.log.push(keys[0] ?? '');
        return result;
      },
    }),
  };
  return facade as unknown as Variables['redis'];
}

interface PaymentHarness extends AdminOpHarnessInstance {
  readonly paymentId: string;
  readonly walletId: string;
  readonly userId: string;
}

/** A seeded, always-feasible wallet movement (settlement is never
 * balance-guarded, so control and op runs can never diverge on feasibility). */
async function postWalletAdjustment(
  walletId: string,
  signedAmountNanoUsd: bigint,
  kind: LedgerLegInput['kind'],
  houseAccount: NonNullable<LedgerLegInput['houseAccount']>
): Promise<void> {
  await runSettlement(db, async (tx) => {
    const wallet = await billingStores.lockWalletWithinTx(tx, walletId);
    const balanceAfter = wallet.balanceNanoUsd + signedAmountNanoUsd;
    const transactionId = crypto.randomUUID();
    await billingStores.insertLedgerLegsWithinTx(tx, [
      {
        transactionId,
        kind,
        amountNanoUsd: signedAmountNanoUsd,
        balanceAfterNanoUsd: balanceAfter,
        walletId,
        idempotencyKey: `admin-payment-test:${transactionId}:wallet`,
      },
      {
        transactionId,
        kind,
        amountNanoUsd: -signedAmountNanoUsd,
        houseAccount,
        idempotencyKey: `admin-payment-test:${transactionId}:house`,
      },
    ]);
    await billingStores.updateWalletBalanceWithinTx(
      tx,
      walletId,
      balanceAfter,
      wallet.ledgerSeq + 1n
    );
  });
}

interface HarnessSeed {
  readonly status: PaymentStatus;
  /** Seeds the wallet with the captured amount — what a `completed` row means. */
  readonly credited?: boolean;
  /**
   * False seeds the row a pre-claim that never reached the provider leaves
   * behind: no capture, so no transaction id on the row.
   */
  readonly charged?: boolean;
  readonly hooks?: AdminOpEngineHooks;
}

async function createPaymentHarness(seed: HarnessSeed): Promise<PaymentHarness> {
  const [user] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (user === undefined) throw new Error('payment harness: user insert returned no row');
  const [wallet] = await db
    .insert(wallets)
    .values(walletFactory.build({ userId: user.id }))
    .returning({ id: wallets.id });
  if (wallet === undefined) throw new Error('payment harness: wallet insert returned no row');
  snapshotWalletIds.push(wallet.id);
  const [payment] = await db
    .insert(payments)
    .values({
      userId: user.id,
      amountNanoUsd: PAYMENT_AMOUNT_NANO_USD,
      status: seed.status,
      idempotencyKey: `pay:${user.id}:${crypto.randomUUID()}`,
      helcimTransactionId:
        seed.charged === false ? null : `admin-payment-test-${crypto.randomUUID()}`,
    })
    .returning({ id: payments.id });
  if (payment === undefined) throw new Error('payment harness: payment insert returned no row');
  if (seed.credited === true) {
    await postWalletAdjustment(wallet.id, PAYMENT_AMOUNT_NANO_USD, 'deposit', 'payments-in');
  }
  const actor = `admin-payment-test-${crypto.randomUUID()}@hushbox.ai`;
  const probe: SnapshotProbeState = { log: [], armed: false };
  // Two separately constructed objects: the snapshot CAS client reaches the
  // effect only through the post-commit half, never from an op body's deps.
  const opDeps: AdminPaymentDeps = { billingStores };
  const postDeps: AdminPaymentPostDeps = { redis: probeRedis(probe) };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminPaymentDeps, AdminPaymentPostDeps>([
      ...adminPaymentOperations,
    ]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps,
    postDeps,
    executorId: `admin-payment-test-${crypto.randomUUID()}`,
    ...(seed.hooks === undefined ? {} : { hooks: seed.hooks }),
  });
  return {
    engine,
    actor,
    paymentId: payment.id,
    walletId: wallet.id,
    userId: user.id,
    projection: async (): Promise<{
      status: PaymentStatus;
      balanceNanoUsd: string;
      hasTransactionId: boolean;
    }> => {
      const balance = await balanceOf(wallet.id);
      return {
        status: await statusOf(payment.id),
        balanceNanoUsd: balance.toString(10),
        // Whether the row carries a provider handle, never which one: the
        // Iron Law case compares against a control harness whose own row was
        // seeded with a different id, and an id left behind by a reversed
        // attach is exactly the residue this catches.
        hasTransactionId: (await transactionIdOrNull(payment.id)) !== null,
      };
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    ephemeral: {
      log: () => probe.log,
      armFailure: () => {
        probe.armed = true;
      },
    },
  };
}

async function statusOf(paymentId: string): Promise<PaymentStatus> {
  const rows = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.id, paymentId));
  const status = rows[0]?.status;
  if (status === undefined) throw new Error('payment harness: payment row is gone');
  return status;
}

async function balanceOf(walletId: string): Promise<bigint> {
  const rows = await db
    .select({ balanceNanoUsd: wallets.balanceNanoUsd })
    .from(wallets)
    .where(eq(wallets.id, walletId));
  const balance = rows[0]?.balanceNanoUsd;
  if (balance === undefined) throw new Error('payment harness: wallet row is gone');
  return balance;
}

async function transactionIdOrNull(paymentId: string): Promise<string | null> {
  const rows = await db
    .select({ helcimTransactionId: payments.helcimTransactionId })
    .from(payments)
    .where(eq(payments.id, paymentId));
  const row = rows[0];
  if (row === undefined) throw new Error('payment harness: payment row is gone');
  return row.helcimTransactionId;
}

async function transactionIdOf(paymentId: string): Promise<string> {
  const transactionId = await transactionIdOrNull(paymentId);
  if (transactionId === null) {
    throw new Error('payment harness: seeded row carries no transaction id');
  }
  return transactionId;
}

/** An id shaped like the one an operator reads off the provider dashboard. */
function dashboardTransactionId(): string {
  return `admin-payment-test-${crypto.randomUUID()}`;
}

async function legsFor(
  paymentId: string
): Promise<readonly { amountNanoUsd: bigint; walletId: string | null }[]> {
  return db
    .select({ amountNanoUsd: ledgerEntries.amountNanoUsd, walletId: ledgerEntries.walletId })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.paymentId, paymentId));
}

function sumOf(legs: readonly { amountNanoUsd: bigint }[]): bigint {
  return legs.reduce((total, leg) => total + leg.amountNanoUsd, 0n);
}

/** Conservation post-condition, scoped to the harness wallet so unrelated
 * suite residue can never fail (or mask) this assertion. */
async function assertConservationCleanFor(walletId: string): Promise<void> {
  const audit = await runConservationAudit(billingStores, db);
  const findings = audit._unsafeUnwrap();
  expect(findings.walletDrift.filter((entry) => entry.walletId === walletId)).toEqual([]);
  const legs = await db
    .select({ transactionId: ledgerEntries.transactionId })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.walletId, walletId));
  const mine = new Set(legs.map((leg) => leg.transactionId));
  expect(findings.unbalancedTransactions.filter((entry) => mine.has(entry.transactionId))).toEqual(
    []
  );
}

function walletOf(harness: AdminOpHarnessInstance): string {
  return (harness as PaymentHarness).walletId;
}

function paymentOf(harness: AdminOpHarnessInstance): string {
  return (harness as PaymentHarness).paymentId;
}

function seededAmountNanoUsd(rng: SeededRng): bigint {
  return (BigInt(Math.floor(rng() * 1_000_000)) + 1n) * 1000n;
}

const interleavingActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'user-spend',
    run: (harness, rng) =>
      postWalletAdjustment(walletOf(harness), -seededAmountNanoUsd(rng), 'charge', 'revenue'),
  },
  {
    name: 'user-top-up',
    run: (harness, rng) =>
      postWalletAdjustment(walletOf(harness), seededAmountNanoUsd(rng), 'deposit', 'payments-in'),
  },
];

function interleavingConfig(): AdminOpInterleavingConfig {
  return {
    seeds: [13, 41],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      paymentId: paymentOf(harness),
      reason: `interleaving verdict ${crypto.randomUUID()}`,
    }),
    actions: interleavingActions,
    afterRun: (harness) => assertConservationCleanFor(walletOf(harness)),
  };
}

function validInputFor(target: { paymentId: string }): Record<string, unknown> {
  return {
    paymentId: target.paymentId,
    reason: `the provider dashboard settles it ${crypto.randomUUID()}`,
  };
}

const INVALID_INPUT = { paymentId: 'not-a-uuid', reason: 'x' };

const forceExpireTarget = { paymentId: '' };
describeAdminOp({
  contract: FORCE_EXPIRE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook', ...options });
    forceExpireTarget.paymentId = harness.paymentId;
    return harness;
  },
  validInput: () => validInputFor(forceExpireTarget),
  invalidInput: INVALID_INPUT,
  interleaving: interleavingConfig(),
});

const restoreTarget = { paymentId: '' };
describeAdminOp({
  contract: RESTORE_CONTRACT,
  createHarness: async (options) => {
    // Seeded with no capture handle, so the battery drives the arm that
    // ATTACHES the operator's id — the only arm whose undo has residue to
    // leave, and therefore the one the Iron Law cases must run. The other arm
    // is driven as the force-expire battery's own undo.
    const harness = await createPaymentHarness({ status: 'expired', charged: false, ...options });
    restoreTarget.paymentId = harness.paymentId;
    return harness;
  },
  validInput: () => ({
    ...validInputFor(restoreTarget),
    helcimTransactionId: dashboardTransactionId(),
  }),
  invalidInput: INVALID_INPUT,
  interleaving: {
    ...interleavingConfig(),
    opInput: (harness) => ({
      paymentId: paymentOf(harness),
      helcimTransactionId: dashboardTransactionId(),
      reason: `interleaving verdict ${crypto.randomUUID()}`,
    }),
  },
});

const completeTarget = { paymentId: '' };
describeAdminOp({
  contract: COMPLETE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook', ...options });
    completeTarget.paymentId = harness.paymentId;
    return harness;
  },
  validInput: () => validInputFor(completeTarget),
  invalidInput: INVALID_INPUT,
  hasEphemeralEffects: true,
  interleaving: interleavingConfig(),
});

const uncompleteTarget = { paymentId: '' };
describeAdminOp({
  contract: UNCOMPLETE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createPaymentHarness({
      status: 'completed',
      credited: true,
      ...options,
    });
    uncompleteTarget.paymentId = harness.paymentId;
    return harness;
  },
  validInput: () => validInputFor(uncompleteTarget),
  invalidInput: INVALID_INPUT,
  hasEphemeralEffects: true,
  interleaving: interleavingConfig(),
});

function execute(
  harness: PaymentHarness,
  name: string,
  paymentId = harness.paymentId
): ReturnType<PaymentHarness['engine']['run']> {
  return harness.engine.run({
    name,
    input: { paymentId, reason: 'the provider dashboard shows the capture settled' },
    actor: harness.actor,
    mode: 'execute',
    role: 'operator',
    idempotencyKey: crypto.randomUUID(),
  });
}

function executeWith(
  harness: PaymentHarness,
  name: string,
  input: Record<string, unknown>
): ReturnType<PaymentHarness['engine']['run']> {
  return harness.engine.run({
    name,
    input,
    actor: harness.actor,
    mode: 'execute',
    role: 'operator',
    idempotencyKey: crypto.randomUUID(),
  });
}

async function executeOk(
  harness: PaymentHarness,
  name: string,
  paymentId = harness.paymentId
): Promise<AdminOpRunResult> {
  const result = await execute(harness, name, paymentId);
  return result._unsafeUnwrap();
}

/**
 * The registered inverse run the way the admin plane runs it: the recorded
 * `inverseInput` verbatim under the operator's own words, claiming the audit
 * row it reverses. Anything the forward op failed to record therefore fails
 * here, at the engine's undo-input comparison, rather than silently.
 */
function undoOf(
  harness: PaymentHarness,
  inverseName: string,
  executed: AdminOpRunResult,
  reason: string
): ReturnType<PaymentHarness['engine']['run']> {
  const recorded = executed.inverseInput;
  if (recorded === null) throw new Error('payment harness: the run recorded no inverse input');
  return harness.engine.run({
    name: inverseName,
    input: withUndoReason(recorded, reason),
    actor: harness.actor,
    mode: 'execute',
    role: 'operator',
    idempotencyKey: crypto.randomUUID(),
    undoes: executed.auditId,
  });
}

describe('payment.forceCompleteAndCredit money semantics', () => {
  it('credits exactly the row amount, posts a zero-sum pair, and completes the row', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });

    await executeOk(harness, 'payment.forceCompleteAndCredit');

    expect(await statusOf(harness.paymentId)).toBe('completed');
    expect(await balanceOf(harness.walletId)).toBe(PAYMENT_AMOUNT_NANO_USD);
    const legs = await legsFor(harness.paymentId);
    expect(legs).toHaveLength(2);
    expect(sumOf(legs)).toBe(0n);
    expect(legs.find((leg) => leg.walletId === harness.walletId)?.amountNanoUsd).toBe(
      PAYMENT_AMOUNT_NANO_USD
    );
    await assertConservationCleanFor(harness.walletId);
  });

  it('refuses a row the webhook already completed and credits nothing a second time', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    await executeOk(harness, 'payment.forceCompleteAndCredit');

    const second = await execute(harness, 'payment.forceCompleteAndCredit');

    expect(second.isErr() && second.error.code).toBe('conflict');
    expect(await balanceOf(harness.walletId)).toBe(PAYMENT_AMOUNT_NANO_USD);
    expect(await legsFor(harness.paymentId)).toHaveLength(2);
  });

  it('refuses a re-posted identical adjustment even once the status allows it', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    // One justification, typed twice: op + payment + amount + reason is the
    // adjustment's logical identity, so the second run derives the leg keys
    // the first already claimed.
    const input = { paymentId: harness.paymentId, reason: 'the dashboard shows one capture' };
    const first = await executeWith(harness, 'payment.forceCompleteAndCredit', input);
    first._unsafeUnwrap();
    await executeOk(harness, 'payment.uncompleteAndClawback');

    const replayed = await executeWith(harness, 'payment.forceCompleteAndCredit', input);

    expect(replayed.isErr() && replayed.error.code).toBe('conflict');
    // The refusal rolled the transition back with it: the row is where the
    // claw back left it, and no third leg pair exists.
    expect(await statusOf(harness.paymentId)).toBe('awaiting_webhook');
    expect(await balanceOf(harness.walletId)).toBe(0n);
    expect(await legsFor(harness.paymentId)).toHaveLength(4);
  });

  it('refuses an unknown payment id with a typed not-found', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });

    const result = await execute(harness, 'payment.forceCompleteAndCredit', crypto.randomUUID());

    expect(result.isErr() && result.error.code).toBe('not_found');
    expect(await statusOf(harness.paymentId)).toBe('awaiting_webhook');
  });

  it('refuses a row whose account was deleted, leaving the money where it is', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    await db.delete(users).where(eq(users.id, harness.userId));

    const result = await execute(harness, 'payment.forceCompleteAndCredit');

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await statusOf(harness.paymentId)).toBe('awaiting_webhook');
  });

  it('writes the post-commit snapshot through with the settled balance', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });

    await executeOk(harness, 'payment.forceCompleteAndCredit');

    const raw = await redis.get(BILLING_KEYS.walletSnapshot.buildKey(harness.walletId));
    const snapshot = BILLING_KEYS.walletSnapshot.schema.parse(raw);
    expect(snapshot).toMatchObject({
      balanceNanoUsd: PAYMENT_AMOUNT_NANO_USD.toString(10),
      ledgerSeq: 1,
    });
  });
});

describe('payment.forceExpire', () => {
  it('expires the row and moves no money', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });

    await executeOk(harness, 'payment.forceExpire');

    expect(await statusOf(harness.paymentId)).toBe('expired');
    expect(await balanceOf(harness.walletId)).toBe(0n);
    expect(await legsFor(harness.paymentId)).toHaveLength(0);
  });

  it('detaches the transaction id the operator names, leaving the row empty', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    const attached = await transactionIdOf(harness.paymentId);

    const result = await executeWith(harness, 'payment.forceExpire', {
      paymentId: harness.paymentId,
      helcimTransactionId: attached,
      reason: 'undoing the restore that attached this id',
    });

    result._unsafeUnwrap();
    expect(await statusOf(harness.paymentId)).toBe('expired');
    expect(await transactionIdOrNull(harness.paymentId)).toBeNull();
  });

  it('refuses a transaction id the row does not carry', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    const attached = await transactionIdOf(harness.paymentId);

    const result = await executeWith(harness, 'payment.forceExpire', {
      paymentId: harness.paymentId,
      helcimTransactionId: dashboardTransactionId(),
      reason: 'a mistyped id must never strip a captured row’s provider identity',
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await statusOf(harness.paymentId)).toBe('awaiting_webhook');
    expect(await transactionIdOrNull(harness.paymentId)).toBe(attached);
  });

  it('records one executed audit row against the payment', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });

    await executeOk(harness, 'payment.forceExpire');

    const rows = await db
      .select({ action: adminAudit.action })
      .from(adminAudit)
      .where(and(eq(adminAudit.actor, harness.actor), eq(adminAudit.targetId, harness.paymentId)));
    expect(rows.map((row) => row.action)).toEqual(['payment.forceExpire']);
  });
});

describe('payment.restoreAwaitingWebhook', () => {
  it('restores an expired row and moves no money', async () => {
    const harness = await createPaymentHarness({ status: 'expired' });

    await executeOk(harness, 'payment.restoreAwaitingWebhook');

    expect(await statusOf(harness.paymentId)).toBe('awaiting_webhook');
    expect(await balanceOf(harness.walletId)).toBe(0n);
    expect(await legsFor(harness.paymentId)).toHaveLength(0);
  });

  it('attaches the transaction id the operator read off the provider dashboard', async () => {
    const harness = await createPaymentHarness({ status: 'expired', charged: false });
    const dashboardId = dashboardTransactionId();

    const result = await executeWith(harness, 'payment.restoreAwaitingWebhook', {
      paymentId: harness.paymentId,
      helcimTransactionId: dashboardId,
      reason: 'the provider dashboard shows this capture settled after all',
    });

    result._unsafeUnwrap();
    expect(await statusOf(harness.paymentId)).toBe('awaiting_webhook');
    // The invariant the op preserves: a row this reaches `awaiting_webhook`
    // always carries the handle the webhook matches on.
    expect(await transactionIdOrNull(harness.paymentId)).toBe(dashboardId);
  });

  it('refuses a transaction id for a row that already carries one', async () => {
    const harness = await createPaymentHarness({ status: 'expired' });
    const original = await transactionIdOf(harness.paymentId);

    const result = await executeWith(harness, 'payment.restoreAwaitingWebhook', {
      paymentId: harness.paymentId,
      helcimTransactionId: dashboardTransactionId(),
      reason: 'a mistyped id must never rewrite a captured row’s provider identity',
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await statusOf(harness.paymentId)).toBe('expired');
    expect(await transactionIdOrNull(harness.paymentId)).toBe(original);
  });

  it('refuses a transaction id another payment row already carries', async () => {
    const other = await createPaymentHarness({ status: 'awaiting_webhook' });
    const takenId = await transactionIdOf(other.paymentId);
    const harness = await createPaymentHarness({ status: 'expired', charged: false });

    const result = await executeWith(harness, 'payment.restoreAwaitingWebhook', {
      paymentId: harness.paymentId,
      helcimTransactionId: takenId,
      reason: 'the id pasted off the dashboard belongs to another payment',
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(result.isErr() && result.error.wireCode).toBe(ERROR_CODES.PAYMENT_TRANSACTION_ID_TAKEN);
    expect(await statusOf(harness.paymentId)).toBe('expired');
    expect(await transactionIdOrNull(harness.paymentId)).toBeNull();
    expect(await transactionIdOrNull(other.paymentId)).toBe(takenId);
  });

  it('refuses a row that never reached the provider, leaving it expired', async () => {
    const harness = await createPaymentHarness({ status: 'expired', charged: false });

    const result = await execute(harness, 'payment.restoreAwaitingWebhook');

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await statusOf(harness.paymentId)).toBe('expired');
  });
});

describe('an operator-supplied transaction id and its undo', () => {
  // The Reversibility Iron Law on the column the money ops key off. A restore
  // that WRITES a provider handle has landed durable state, so its registered
  // inverse must remove exactly that handle; leaving it behind would return the
  // row to `expired` carrying identity it never had, and the next restore of
  // that row would then pass the captured-charge refusal on the operator's own
  // leftovers rather than on a capture.
  it('leaves nothing behind when the restore that attached it is undone', async () => {
    const harness = await createPaymentHarness({ status: 'expired', charged: false });
    const dashboardId = dashboardTransactionId();
    const restored = await executeWith(harness, 'payment.restoreAwaitingWebhook', {
      paymentId: harness.paymentId,
      helcimTransactionId: dashboardId,
      reason: 'the provider dashboard shows this capture settled after all',
    });

    const undone = await undoOf(
      harness,
      'payment.forceExpire',
      restored._unsafeUnwrap(),
      'the dashboard entry was another customer’s capture'
    );

    undone._unsafeUnwrap();
    expect(await statusOf(harness.paymentId)).toBe('expired');
    expect(await transactionIdOrNull(harness.paymentId)).toBeNull();
  });

  it('comes back when the force-expire that detached it is undone', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    const attached = await transactionIdOf(harness.paymentId);
    const expired = await executeWith(harness, 'payment.forceExpire', {
      paymentId: harness.paymentId,
      helcimTransactionId: attached,
      reason: 'the provider denies this capture ever settled',
    });
    expired._unsafeUnwrap();
    expect(await transactionIdOrNull(harness.paymentId)).toBeNull();

    const undone = await undoOf(
      harness,
      'payment.restoreAwaitingWebhook',
      expired._unsafeUnwrap(),
      'the provider corrected itself: the capture is on the account'
    );

    undone._unsafeUnwrap();
    expect(await statusOf(harness.paymentId)).toBe('awaiting_webhook');
    expect(await transactionIdOrNull(harness.paymentId)).toBe(attached);
  });
});

describe('payment.uncompleteAndClawback', () => {
  it('claws back exactly the row amount and returns the row to awaiting_webhook', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    await executeOk(harness, 'payment.forceCompleteAndCredit');

    await executeOk(harness, 'payment.uncompleteAndClawback');

    expect(await statusOf(harness.paymentId)).toBe('awaiting_webhook');
    expect(await balanceOf(harness.walletId)).toBe(0n);
    const legs = await legsFor(harness.paymentId);
    expect(legs).toHaveLength(4);
    expect(sumOf(legs)).toBe(0n);
    await assertConservationCleanFor(harness.walletId);
  });
});

describe('a webhook-credited row the operator clawed back', () => {
  it('lets a later delivery re-complete the row without posting a second credit', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    const transactionId = await transactionIdOf(harness.paymentId);
    const credited = await deliverCompletedWebhook(billingStores, db, transactionId);
    expect(credited._unsafeUnwrap().disposition.kind).toBe('credited');
    await executeOk(harness, 'payment.uncompleteAndClawback');

    const redelivered = await deliverCompletedWebhook(billingStores, db, transactionId);

    // The claw back returns the row to `awaiting_webhook` but leaves the
    // webhook's own per-payment deposit key claimed, so the second credit has
    // nothing to post. Already-done is a no-op, never a failure the provider
    // is told to retry forever.
    expect(redelivered.isOk()).toBe(true);
    expect(await statusOf(harness.paymentId)).toBe('completed');
    expect(await balanceOf(harness.walletId)).toBe(0n);
    const legs = await legsFor(harness.paymentId);
    expect(legs).toHaveLength(4);
    expect(sumOf(legs)).toBe(0n);
    await assertConservationCleanFor(harness.walletId);
  });
});

describe('every payment op refuses a status it does not own', () => {
  // Both axes are read from their sources rather than restated here: the row
  // states from the enum behind the `payment_status` pgEnum, the operations
  // from the registered group. A sixth status or a fifth operation therefore
  // grows this matrix, where a restated axis would have let it ship uncovered.
  const OWNED_STATUS: Record<string, PaymentStatus> = {
    'payment.forceExpire': 'awaiting_webhook',
    'payment.restoreAwaitingWebhook': 'expired',
    'payment.forceCompleteAndCredit': 'awaiting_webhook',
    'payment.uncompleteAndClawback': 'completed',
  };

  function ownedStatusFor(name: string): PaymentStatus {
    const owned = OWNED_STATUS[name];
    if (owned === undefined) {
      throw new Error(`the refusal matrix has no starting status for ${name} — add one`);
    }
    return owned;
  }

  it('carries a starting status for every registered payment operation, and no other', () => {
    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect(Object.keys(OWNED_STATUS).toSorted(byName)).toEqual(
      adminPaymentOperations.map((operation) => operation.contract.name).toSorted(byName)
    );
  });

  for (const operation of adminPaymentOperations) {
    const name = operation.contract.name;
    const owned = ownedStatusFor(name);
    for (const status of PAYMENT_STATUSES.filter((candidate) => candidate !== owned)) {
      it(`${name} refuses a ${status} row and leaves it untouched`, async () => {
        const harness = await createPaymentHarness({ status });

        const result = await execute(harness, name);

        expect(result.isErr() && result.error.code).toBe('conflict');
        expect(await statusOf(harness.paymentId)).toBe(status);
        expect(await balanceOf(harness.walletId)).toBe(0n);
        expect(await legsFor(harness.paymentId)).toHaveLength(0);
      });
    }
  }
});

describe('an admin force-complete racing the webhook', () => {
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

  it('commits exactly one credit when both claim the same row concurrently', async () => {
    const harness = await createPaymentHarness({ status: 'awaiting_webhook' });
    const transactionId = await transactionIdOf(harness.paymentId);

    // Both parties are held with their transactions OPEN and neither holding
    // a lock on the payments row, so the release puts two live claims in
    // flight rather than two calls that merely started together. Gating
    // AFTER either claim would deadlock instead: the second party would block
    // on the first's row lock and never reach the meeting point.
    const arrive = meetingPoint(2);
    const gatedAdminStores: typeof billingStores = {
      ...billingStores,
      transitionPaymentStatusWithinTx: async (...parameters) => {
        await arrive();
        return billingStores.transitionPaymentStatusWithinTx(...parameters);
      },
    };
    const gatedWebhookStores: typeof billingStores = {
      ...billingStores,
      claimPaymentCompletedWithinTx: async (...parameters) => {
        await arrive();
        return billingStores.claimPaymentCompletedWithinTx(...parameters);
      },
    };
    const racingEngine = createAdminOpEngine({
      db,
      registry: createAdminOpRegistry<AdminPaymentDeps, AdminPaymentPostDeps>([
        ...adminPaymentOperations,
      ]),
      stores: adminStores,
      telemetry: noopTelemetry(),
      opDeps: { billingStores: gatedAdminStores },
      postDeps: { redis: probeRedis({ log: [], armed: false }) },
      executorId: `admin-payment-race-${crypto.randomUUID()}`,
    });

    const [adminOutcome, webhookOutcome] = await Promise.all([
      racingEngine.run({
        name: 'payment.forceCompleteAndCredit',
        input: { paymentId: harness.paymentId, reason: 'the dashboard shows it settled' },
        actor: harness.actor,
        mode: 'execute',
        role: 'operator',
        idempotencyKey: crypto.randomUUID(),
      }),
      deliverCompletedWebhook(gatedWebhookStores, dbRival, transactionId),
    ]);

    // Exactly one of the two claimed the row; the loser refused rather than
    // posting a second deposit against the same capture. Which one wins is
    // the point — both orderings are legal, and each has its own refusal.
    const webhook = webhookOutcome._unsafeUnwrap();
    expect(adminOutcome.isOk()).not.toBe(webhook.claimed);
    if (adminOutcome.isErr()) {
      expect(adminOutcome.error.code).toBe('conflict');
      expect(webhook.disposition.kind).toBe('credited');
    } else {
      expect(webhook.disposition.kind).toBe('already-completed');
    }
    expect(await statusOf(harness.paymentId)).toBe('completed');
    expect(await balanceOf(harness.walletId)).toBe(PAYMENT_AMOUNT_NANO_USD);
    const legs = await legsFor(harness.paymentId);
    expect(legs).toHaveLength(2);
    expect(sumOf(legs)).toBe(0n);
    await assertConservationCleanFor(harness.walletId);
  });
});

/** The provider's own `payment.completed` delivery, against real stores. */
function deliverCompletedWebhook(
  stores: typeof billingStores,
  database: typeof db,
  transactionId: string
): ReturnType<typeof applyPaymentWebhookEvent> {
  return applyPaymentWebhookEvent(
    {
      db: database,
      stores,
      accountDefense: {
        lockForChargebackWithinTx: () => {
          throw new Error('a completed event never locks an account');
        },
      },
      accountLockedEmail: {
        sendChargebackLockEmail: () => {
          throw new Error('a completed event never sends a lock email');
        },
      },
      registry: emptyJobRegistry(),
    },
    { type: 'payment.completed', transactionId }
  );
}

/** The `payment.completed` webhook arm reaches no job registration. */
function emptyJobRegistry(): Parameters<typeof applyPaymentWebhookEvent>[0]['registry'] {
  return {
    get: () => {
      throw new Error('a completed event enqueues no job');
    },
    list: () => [],
  } as unknown as Parameters<typeof applyPaymentWebhookEvent>[0]['registry'];
}
