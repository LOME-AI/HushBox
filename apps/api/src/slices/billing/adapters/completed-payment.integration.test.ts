import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, payments, users, type Database } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { hasCompletedPayment } from './completed-payment.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined) {
  throw new Error('DATABASE_URL is required for the completed-payment read integration test');
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

let db: Database;
const createdUserIds: string[] = [];
const createdPaymentIds: string[] = [];

beforeAll(() => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
});

afterAll(async () => {
  if (createdPaymentIds.length > 0) {
    await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const [row] = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@completed-payment.test`,
        username: `cp${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  if (row === undefined) throw new Error('user seed failed');
  createdUserIds.push(row.id);
  return row.id;
}

async function seedPayment(
  userId: string,
  status: 'pending' | 'awaiting_webhook' | 'completed' | 'failed' | 'expired'
): Promise<void> {
  const [row] = await db
    .insert(payments)
    .values({
      userId,
      amountNanoUsd: 10_000_000_000n,
      status,
      idempotencyKey: `completed-payment-test:${crypto.randomUUID()}`,
    })
    .returning({ id: payments.id });
  if (row === undefined) throw new Error('payment seed failed');
  createdPaymentIds.push(row.id);
}

describe('hasCompletedPayment', () => {
  it('answers false for an account that has never paid', async () => {
    const userId = await seedUser();
    const answer = await hasCompletedPayment(db, userId);
    expect(answer._unsafeUnwrap()).toBe(false);
  });

  it('answers true once one payment has completed', async () => {
    const userId = await seedUser();
    await seedPayment(userId, 'completed');
    const answer = await hasCompletedPayment(db, userId);
    expect(answer._unsafeUnwrap()).toBe(true);
  });

  it('does not count a payment that never reached a completed status', async () => {
    const userId = await seedUser();
    for (const status of ['pending', 'awaiting_webhook', 'failed', 'expired'] as const) {
      await seedPayment(userId, status);
    }
    const answer = await hasCompletedPayment(db, userId);
    expect(answer._unsafeUnwrap()).toBe(false);
  });

  it('answers unavailable rather than throwing when the query cannot run', async () => {
    // An id the column's type refuses, so the driver rejects and the read's
    // own error mapping is what the caller meets.
    const answer = await hasCompletedPayment(db, 'not-a-user-id');
    const failure = answer._unsafeUnwrapErr();
    expect(failure.code).toBe('unavailable');
  });

  it('does not answer true for one account because another account paid', async () => {
    const payer = await seedUser();
    const other = await seedUser();
    await seedPayment(payer, 'completed');
    const answer = await hasCompletedPayment(db, other);
    expect(answer._unsafeUnwrap()).toBe(false);
  });
});
