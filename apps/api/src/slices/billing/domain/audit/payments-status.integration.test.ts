import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, payments, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { createBillingStores } from '../../adapters/stores.js';
import { PAYMENT_MINIMUM_NANO_USD } from '../payments/payments.js';
import { runPaymentsStatusAudit, unresolvedPaymentCutoff } from './payments-status.js';
import type { PaymentStatus } from '../../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for payments-status audit integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdPaymentIds: string[] = [];
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blpsa${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@payments-status.test`,
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

/** Seeds one pre-claim, then forces the status and age the case needs. */
async function seedPayment(
  userId: string,
  status: PaymentStatus,
  createdAt: Date
): Promise<string> {
  const { payment } = await runSettlement(db, (tx) =>
    stores.insertPaymentIfAbsentWithinTx(tx, {
      userId,
      amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
      idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
    })
  );
  await db.update(payments).set({ status, createdAt }).where(eq(payments.id, payment.id));
  createdPaymentIds.push(payment.id);
  return payment.id;
}

/** An instant comfortably past the cutoff, so the row is unambiguously aged. */
function agedInstant(now: Date): Date {
  return new Date(unresolvedPaymentCutoff(now).getTime() - 60 * 60 * 1000);
}

async function countUnresolved(now: Date): Promise<number> {
  const result = await runPaymentsStatusAudit(stores, db, now);
  return result._unsafeUnwrap().unresolvedCount;
}

afterAll(async () => {
  if (createdPaymentIds.length > 0) {
    await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('runPaymentsStatusAudit', () => {
  it('counts a pending row aged past the cutoff', async () => {
    const now = new Date();
    const userId = await createUser();
    const before = await countUnresolved(now);

    await seedPayment(userId, 'pending', agedInstant(now));

    expect(await countUnresolved(now)).toBe(before + 1);
  });

  it('counts an awaiting_webhook row aged past the cutoff', async () => {
    // The silent class: the card was captured, so this row is a user charged
    // and never credited.
    const now = new Date();
    const userId = await createUser();
    const before = await countUnresolved(now);

    await seedPayment(userId, 'awaiting_webhook', agedInstant(now));

    expect(await countUnresolved(now)).toBe(before + 1);
  });

  it('ignores a pending row still inside the cutoff', async () => {
    const now = new Date();
    const userId = await createUser();
    const before = await countUnresolved(now);

    await seedPayment(userId, 'pending', now);

    expect(await countUnresolved(now)).toBe(before);
  });

  it('ignores an awaiting_webhook row still inside the cutoff', async () => {
    const now = new Date();
    const userId = await createUser();
    const before = await countUnresolved(now);

    await seedPayment(userId, 'awaiting_webhook', now);

    expect(await countUnresolved(now)).toBe(before);
  });

  it('ignores an aged row that reached a verdict', async () => {
    const now = new Date();
    const userId = await createUser();
    const before = await countUnresolved(now);

    for (const status of ['completed', 'failed', 'expired'] as const) {
      await seedPayment(userId, status, agedInstant(now));
    }

    expect(await countUnresolved(now)).toBe(before);
  });

  it('leaves the rows it counted untouched', async () => {
    const now = new Date();
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'awaiting_webhook', agedInstant(now));
    const seeded = await db.select().from(payments).where(eq(payments.id, paymentId));

    expect(await countUnresolved(now)).toBeGreaterThan(0);

    const after = await db.select().from(payments).where(eq(payments.id, paymentId));
    expect(after).toEqual(seeded);
  });
});
