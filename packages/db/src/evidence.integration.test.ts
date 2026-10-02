import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from './client';
import { serviceEvidence } from './schema/service-evidence';
import {
  recordServiceEvidence,
  verifyServiceEvidence,
  SERVICE_NAMES,
  type ServiceName,
} from './evidence';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

describe('evidence', () => {
  let db: Database;
  // The dev database is shared with concurrent runs: every row this suite
  // writes carries the run-unique prefix, and cleanup deletes only those rows.
  const testRunId = `test-${String(Date.now())}`;

  beforeAll(() => {
    db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterAll(async () => {
    await db
      .delete(serviceEvidence)
      .where(eq(serviceEvidence.service, `${testRunId}-openrouter-catalog`));
    await db
      .delete(serviceEvidence)
      .where(eq(serviceEvidence.service, `${testRunId}-helcim-webhook`));
    await db.$client.end();
  });

  describe('SERVICE_NAMES', () => {
    // Exhaustive rather than per-name: a name nothing writes is the drift this
    // registry has already suffered, and only a closed comparison catches an
    // addition. Compared as a sorted set, so source order stays free to change.
    it('declares exactly the seams a CI step proves', () => {
      expect(Object.values(SERVICE_NAMES).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'brave-search',
        'helcim',
        'helcim-webhook',
        'linear',
        'openrouter-catalog',
        'openrouter-inference',
        'push-fcm',
        'r2-gc',
        'r2-storage',
      ]);
    });

    it('has correct type inference', () => {
      const name: ServiceName = SERVICE_NAMES.OPENROUTER_CATALOG;
      expect(name).toBe('openrouter-catalog');
    });
  });

  describe('recordServiceEvidence', () => {
    it('does nothing when isCI is false', async () => {
      const testService = `${testRunId}-openrouter-catalog` as ServiceName;

      await recordServiceEvidence(db, false, testService);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows).toHaveLength(0);
    });

    it('inserts record when isCI is true', async () => {
      const testService = `${testRunId}-openrouter-catalog` as ServiceName;

      await recordServiceEvidence(db, true, testService);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.service).toBe(testService);
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    });

    it('stores details when provided', async () => {
      const testService = `${testRunId}-helcim-webhook` as ServiceName;
      const details = { requestId: '123', status: 'success' };

      await recordServiceEvidence(db, true, testService, details);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toEqual(details);
    });

    it('allows multiple records for same service', async () => {
      const testService = `${testRunId}-openrouter-catalog` as ServiceName;

      await recordServiceEvidence(db, true, testService);
      await recordServiceEvidence(db, true, testService);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('verifyServiceEvidence', () => {
    beforeEach(async () => {
      await recordServiceEvidence(db, true, `${testRunId}-openrouter-catalog` as ServiceName);
    });

    it('returns success when all required services have evidence', async () => {
      const result = await verifyServiceEvidence(db, [
        `${testRunId}-openrouter-catalog` as ServiceName,
      ]);

      expect(result.success).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('returns failure with missing services', async () => {
      const result = await verifyServiceEvidence(db, [
        `${testRunId}-openrouter-catalog` as ServiceName,
        `${testRunId}-nonexistent` as ServiceName,
      ]);

      expect(result.success).toBe(false);
      expect(result.missing).toContain(`${testRunId}-nonexistent`);
    });

    it('returns success for empty required list', async () => {
      const result = await verifyServiceEvidence(db, []);

      expect(result.success).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('handles multiple required services', async () => {
      await recordServiceEvidence(db, true, `${testRunId}-helcim-webhook` as ServiceName);

      const result = await verifyServiceEvidence(db, [
        `${testRunId}-openrouter-catalog` as ServiceName,
        `${testRunId}-helcim-webhook` as ServiceName,
      ]);

      expect(result.success).toBe(true);
      expect(result.missing).toHaveLength(0);
    });
  });
});
