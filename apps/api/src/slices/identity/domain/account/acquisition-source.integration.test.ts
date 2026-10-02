import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  payments,
  userAcquisition,
  users,
  type Database,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { createIdentityStores } from '../../adapters/stores.js';
import { applySelfReport, readAcquisitionSource } from './acquisition-source.js';
import type { SelfReportAction } from '@hushbox/shared';
import type { IdentityUsersStore } from '../../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined) {
  throw new Error('DATABASE_URL is required for the acquisition-source integration test');
}

const BYTES = new Uint8Array([1, 2, 3, 4]);
const NOW = new Date(TEST_DAY_START + 3 * HOUR_MS);

let db: Database;
let store: IdentityUsersStore;
const createdUserIds: string[] = [];
const createdPaymentIds: string[] = [];

beforeAll(() => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  store = createIdentityStores(db).users;
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

async function seedAccount(options: { readonly withAcquisition: boolean }): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const [row] = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@acquisition-source.test`,
        username: `as${suffix}`,
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
  if (options.withAcquisition) {
    await db
      .insert(userAcquisition)
      .values({ userId: row.id, campaign: 'direct', platform: 'web' });
  }
  return row.id;
}

async function seedCompletedPayment(userId: string): Promise<void> {
  const [row] = await db
    .insert(payments)
    .values({
      userId,
      amountNanoUsd: 10_000_000_000n,
      status: 'completed',
      idempotencyKey: `acquisition-source-test:${crypto.randomUUID()}`,
    })
    .returning({ id: payments.id });
  if (row === undefined) throw new Error('payment seed failed');
  createdPaymentIds.push(row.id);
}

function argsFor(userId: string): { store: IdentityUsersStore; db: Database; userId: string } {
  return { store, db, userId };
}

async function duePromptOf(userId: string): Promise<string | null> {
  const view = await readAcquisitionSource(argsFor(userId));
  const read = view._unsafeUnwrap();
  return read.duePrompt;
}

/** Applies one verb and unwraps, so no Result is dropped. */
async function apply(userId: string, action: SelfReportAction): Promise<void> {
  const applied = await applySelfReport(argsFor(userId), action, NOW);
  applied._unsafeUnwrap();
}

async function readRow(
  userId: string
): Promise<{ channel: string | null; context: string | null; skipped: string | null }> {
  const [row] = await db
    .select({
      channel: userAcquisition.selfReportedChannel,
      context: userAcquisition.selfReportedContext,
      skipped: userAcquisition.selfReportSkipped,
    })
    .from(userAcquisition)
    .where(inArray(userAcquisition.userId, [userId]));
  if (row === undefined) throw new Error('acquisition row missing');
  return row;
}

describe('readAcquisitionSource', () => {
  it('says nothing is due for an account carrying no acquisition row', async () => {
    const userId = await seedAccount({ withAcquisition: false });
    expect(await duePromptOf(userId)).toBeNull();
  });

  it('walks a fresh account from post-signup through a skip, a payment and an answer', async () => {
    const userId = await seedAccount({ withAcquisition: true });

    expect(await duePromptOf(userId)).toBe('post_signup');

    await apply(userId, { action: 'skip', context: 'post_signup' });
    expect(await duePromptOf(userId)).toBeNull();

    await seedCompletedPayment(userId);
    expect(await duePromptOf(userId)).toBe('first_payment');

    await apply(userId, { action: 'answer', channel: 'podcast', context: 'first_payment' });
    expect(await duePromptOf(userId)).toBeNull();
  });

  it('stops asking once both contexts have been skipped', async () => {
    const userId = await seedAccount({ withAcquisition: true });
    await seedCompletedPayment(userId);

    await apply(userId, { action: 'skip', context: 'post_signup' });
    await apply(userId, { action: 'skip', context: 'first_payment' });

    expect(await duePromptOf(userId)).toBeNull();
  });
});

describe('applySelfReport', () => {
  it('records the channel, the context it was asked in, and when', async () => {
    const userId = await seedAccount({ withAcquisition: true });

    await apply(userId, { action: 'answer', channel: 'friend', context: 'post_signup' });

    const row = await readRow(userId);
    expect(row.channel).toBe('friend');
    expect(row.context).toBe('post_signup');
  });

  it('leaves the first answer standing when a second one arrives', async () => {
    const userId = await seedAccount({ withAcquisition: true });

    await apply(userId, { action: 'answer', channel: 'friend', context: 'post_signup' });
    await apply(userId, { action: 'answer', channel: 'ad', context: 'first_payment' });

    const row = await readRow(userId);
    expect(row.channel).toBe('friend');
    expect(row.context).toBe('post_signup');
  });

  it('keeps the later skip when an earlier one is replayed', async () => {
    const userId = await seedAccount({ withAcquisition: true });

    await apply(userId, { action: 'skip', context: 'first_payment' });
    await apply(userId, { action: 'skip', context: 'post_signup' });

    const row = await readRow(userId);
    expect(row.skipped).toBe('first_payment');
  });

  it('records the skip against the account rather than the device', async () => {
    const userId = await seedAccount({ withAcquisition: true });

    await apply(userId, { action: 'skip', context: 'post_signup' });

    const row = await readRow(userId);
    expect(row.skipped).toBe('post_signup');
  });

  it('answers a skip for an account with no acquisition row without failing', async () => {
    const userId = await seedAccount({ withAcquisition: false });

    const result = await applySelfReport(
      argsFor(userId),
      { action: 'skip', context: 'post_signup' },
      NOW
    );
    const view = result._unsafeUnwrap();

    expect(view.duePrompt).toBeNull();
  });
});
