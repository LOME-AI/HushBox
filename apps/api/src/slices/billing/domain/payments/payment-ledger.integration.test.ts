import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { createBillingStores } from '../../adapters/stores.js';
import { postPaymentAdjustmentWithinTx } from './payment-ledger.js';
import { PAYMENT_MINIMUM_NANO_USD, depositAdjustmentKeys } from './payments.js';
import type { PaymentAdjustmentKeys, PaymentAdjustmentPosting } from './payment-ledger.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for payment ledger integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blledg${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@payment-ledger.test`,
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

async function createPayment(userId: string): Promise<string> {
  const { payment } = await runSettlement(db, (tx) =>
    stores.insertPaymentIfAbsentWithinTx(tx, {
      userId,
      amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
      idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
    })
  );
  return payment.id;
}

/** The operator's strategy: keys derived from an adjustment identity, not the row. */
function adminKeys(): PaymentAdjustmentKeys {
  const identity = crypto.randomUUID();
  return {
    transactionId: crypto.randomUUID(),
    wallet: `admin:payment.forceCompleteAndCredit:${identity}:wallet`,
    house: `admin:payment.forceCompleteAndCredit:${identity}:house`,
  };
}

function credit(
  paymentId: string,
  userId: string,
  keys: PaymentAdjustmentKeys
): Promise<PaymentAdjustmentPosting> {
  return runSettlement(db, (tx) =>
    postPaymentAdjustmentWithinTx(stores, tx, {
      paymentId,
      userId,
      kind: 'deposit',
      deltaNanoUsd: PAYMENT_MINIMUM_NANO_USD,
      keys,
    })
  );
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const paymentRows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(inArray(payments.userId, createdUserIds));
    const paymentIds = paymentRows.map((row) => row.id);
    if (paymentIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.paymentId, paymentIds));
      await db.delete(payments).where(inArray(payments.id, paymentIds));
    }
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('postPaymentAdjustmentWithinTx', () => {
  it('posts the payer purchased wallet against payments-in with the payment on both legs', async () => {
    const userId = await createUser();
    const paymentId = await createPayment(userId);

    const posting = await credit(paymentId, userId, depositAdjustmentKeys(paymentId));

    expect(posting.posted).toBe(true);
    const legs = await db
      .select({
        amountNanoUsd: ledgerEntries.amountNanoUsd,
        houseAccount: ledgerEntries.houseAccount,
        paymentId: ledgerEntries.paymentId,
        walletId: ledgerEntries.walletId,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    const walletRows = await db
      .select({ id: wallets.id, type: wallets.type })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(walletRows).toEqual([{ id: posting.wallet.id, type: 'purchased' }]);
    expect(legs.every((leg) => leg.paymentId === paymentId)).toBe(true);
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    expect(legs.find((leg) => leg.walletId === posting.wallet.id)?.amountNanoUsd).toBe(
      PAYMENT_MINIMUM_NANO_USD
    );
    expect(legs.find((leg) => leg.walletId === null)?.houseAccount).toBe('payments-in');
  });

  it('reports a no-op and moves no balance when the keys are already claimed', async () => {
    const userId = await createUser();
    const paymentId = await createPayment(userId);
    const keys = depositAdjustmentKeys(paymentId);
    await credit(paymentId, userId, keys);

    const replayed = await credit(paymentId, userId, keys);

    expect(replayed.posted).toBe(false);
    const walletRows = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd, ledgerSeq: wallets.ledgerSeq })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(walletRows[0]).toEqual({ balanceNanoUsd: PAYMENT_MINIMUM_NANO_USD, ledgerSeq: 1n });
  });

  it('lets a second key strategy post over a payment the first already settled', async () => {
    // Why the admin ops keep their own keys: a claw back returns a row to
    // `awaiting_webhook`, where a real redelivery must still be able to credit.
    const userId = await createUser();
    const paymentId = await createPayment(userId);
    await credit(paymentId, userId, adminKeys());

    const redelivered = await credit(paymentId, userId, depositAdjustmentKeys(paymentId));

    expect(redelivered.posted).toBe(true);
    const walletRows = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(PAYMENT_MINIMUM_NANO_USD * 2n);
  });
});
