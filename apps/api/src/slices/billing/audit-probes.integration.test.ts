import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { writeThroughSnapshot } from './index.js';
import { BILLING_KEYS } from './domain/keys.js';
import { createBillingAuditProbes } from './audit-probes.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Redis env are required for billing audit probe tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

afterAll(async () => {
  await db.$client.end();
});

describe('createBillingAuditProbes', () => {
  it('runs the real read-only probes end to end', async () => {
    const probes = createBillingAuditProbes(db, redis, () => new Date());
    const findings = await probes.audit();
    expect(findings.isOk()).toBe(true);
    const paymentsStatus = await probes.auditPaymentsStatus();
    expect(paymentsStatus._unsafeUnwrap().unresolvedCount).toBeGreaterThanOrEqual(0);
    const walletId = crypto.randomUUID();
    const written = await writeThroughSnapshot(redis, {
      walletId,
      balanceNanoUsd: 1n,
      ledgerSeq: 1n,
      walletType: 'purchased',
    });
    written._unsafeUnwrap();
    try {
      const walletIds = await probes.listWalletIds();
      expect(walletIds._unsafeUnwrap()).toContain(walletId);
      // No wallets row exists for the seeded id, so the comparison resolves
      // null — the full Redis + Postgres path still executed.
      const compared = await probes.compare(walletId);
      expect(compared._unsafeUnwrap()).toBeNull();
    } finally {
      await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
    }
  });
});
