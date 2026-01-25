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
  const testRunId = `test-${String(Date.now())}`;

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  afterAll(async () => {
    // Clean up test evidence records
    await db.delete(serviceEvidence).where(eq(serviceEvidence.service, `${testRunId}-openrouter`));
    await db.delete(serviceEvidence).where(eq(serviceEvidence.service, `${testRunId}-hookdeck`));
  });

  describe('SERVICE_NAMES', () => {
    it('exports expected service names', () => {
      expect(SERVICE_NAMES.OPENROUTER).toBe('openrouter');
      expect(SERVICE_NAMES.HOOKDECK).toBe('hookdeck');
    });

    it('has correct type inference', () => {
      const name: ServiceName = SERVICE_NAMES.OPENROUTER;
      expect(name).toBe('openrouter');
    });
  });

  describe('recordServiceEvidence', () => {
    it('does nothing when isCI is false', async () => {
      const testService = `${testRunId}-openrouter` as ServiceName;

      await recordServiceEvidence(db, false, testService);

      const rows = await db
        .select()
        .from(serviceEvidence)
        .where(eq(serviceEvidence.service, testService));

      expect(rows).toHaveLength(0);
    });

    it('inserts record when isCI is true', async () => {
      const testService = `${testRunId}-openrouter` as ServiceName;

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
      const testService = `${testRunId}-hookdeck` as ServiceName;
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
      const testService = `${testRunId}-openrouter` as ServiceName;

      // First record already inserted in previous test
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
      // Ensure test records exist
      await recordServiceEvidence(db, true, `${testRunId}-openrouter` as ServiceName);
    });

    it('returns success when all required services have evidence', async () => {
      const result = await verifyServiceEvidence(db, [`${testRunId}-openrouter` as ServiceName]);

      expect(result.success).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('returns failure with missing services', async () => {
      const result = await verifyServiceEvidence(db, [
        `${testRunId}-openrouter` as ServiceName,
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
      await recordServiceEvidence(db, true, `${testRunId}-hookdeck` as ServiceName);

      const result = await verifyServiceEvidence(db, [
        `${testRunId}-openrouter` as ServiceName,
        `${testRunId}-hookdeck` as ServiceName,
      ]);

      expect(result.success).toBe(true);
      expect(result.missing).toHaveLength(0);
    });
  });
});
