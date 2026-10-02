import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, users, verificationTokens } from '@hushbox/db';
import { purgeExpiredVerificationTokens } from './verification-token-retention.js';
import type { DbTransaction } from '../../../lib/idempotency/transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for verification-token retention integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const BLOB = new Uint8Array([1, 2, 3]);

class Rollback extends Error {}

async function withRollback<T>(function_: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(tx) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

async function insertUser(tx: DbTransaction): Promise<string> {
  const marker = crypto.randomUUID().slice(0, 8);
  const rows = await tx
    .insert(users)
    .values({
      email: `token-retention-${marker}@test.hushbox.ai`,
      username: `vtr_${marker}`,
      opaqueRegistration: BLOB,
      opaqueServerMaterial: BLOB,
      opaqueKekFingerprint: BLOB,
      publicKey: BLOB,
      passwordWrappedPrivateKey: BLOB,
      recoveryWrappedPrivateKey: BLOB,
      recoveryPublicKey: BLOB,
    })
    .returning({ id: users.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert user');
  return row.id;
}

async function insertToken(
  tx: DbTransaction,
  userId: string,
  expiresInHours: number
): Promise<string> {
  const rows = await tx
    .insert(verificationTokens)
    .values({
      userId,
      token: crypto.randomUUID(),
      purpose: 'email_verification',
      expiresAt: sql`now() + make_interval(hours => ${expiresInHours})`,
    })
    .returning({ id: verificationTokens.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert verification token');
  return row.id;
}

async function exists(tx: DbTransaction, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: verificationTokens.id })
    .from(verificationTokens)
    .where(eq(verificationTokens.id, id));
  return rows.length === 1;
}

afterAll(async () => {
  await db.$client.end();
});

describe('purgeExpiredVerificationTokens', () => {
  it('deletes a token whose expiry has passed', async () => {
    const kept = await withRollback(async (tx) => {
      const userId = await insertUser(tx);
      const expiredId = await insertToken(tx, userId, -1);
      await purgeExpiredVerificationTokens(tx, { batchSize: 1000 });
      return exists(tx, expiredId);
    });
    expect(kept).toBe(false);
  });

  it('keeps a token that has not expired', async () => {
    const kept = await withRollback(async (tx) => {
      const userId = await insertUser(tx);
      const liveId = await insertToken(tx, userId, 1);
      await purgeExpiredVerificationTokens(tx, { batchSize: 1000 });
      return exists(tx, liveId);
    });
    expect(kept).toBe(true);
  });

  it('deletes at most the batch size per call', async () => {
    const counts = await withRollback(async (tx) => {
      const userId = await insertUser(tx);
      await insertToken(tx, userId, -2);
      await insertToken(tx, userId, -3);
      await insertToken(tx, userId, -4);
      const first = await purgeExpiredVerificationTokens(tx, { batchSize: 2 });
      const second = await purgeExpiredVerificationTokens(tx, { batchSize: 2 });
      return { first, second };
    });
    expect(counts.first).toBe(2);
    expect(counts.second).toBeGreaterThanOrEqual(1);
  });
});
