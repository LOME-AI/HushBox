import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG, guestUsage, type Database } from '@lome-chat/db';
import { GUEST_MESSAGE_LIMIT } from '@lome-chat/shared';
import { checkGuestUsage, incrementGuestUsage } from './guest-usage.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('guest usage service', () => {
  let db: Database;
  const createdIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    // Clean up created records
    if (createdIds.length > 0) {
      for (const id of createdIds) {
        await db.delete(guestUsage).where(eq(guestUsage.id, id));
      }
      createdIds.length = 0;
    }
  });

  function getUtcMidnight(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  function getYesterdayMidnight(): Date {
    const midnight = getUtcMidnight();
    midnight.setUTCDate(midnight.getUTCDate() - 1);
    return midnight;
  }

  describe('checkGuestUsage', () => {
    it('returns canSend=true for new guest with no prior usage', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      const result = await checkGuestUsage(db, guestToken, ipHash);

      expect(result.canSend).toBe(true);
      expect(result.messageCount).toBe(0);
      expect(result.limit).toBe(GUEST_MESSAGE_LIMIT);
    });

    it('returns current message count for existing guest', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      // Create existing usage record
      const [record] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash,
          messageCount: 3,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!record) throw new Error('Failed to create test record');
      createdIds.push(record.id);

      const result = await checkGuestUsage(db, guestToken, ipHash);

      expect(result.canSend).toBe(true);
      expect(result.messageCount).toBe(3);
    });

    it('returns canSend=false when message count equals limit', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      const [record] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash,
          messageCount: GUEST_MESSAGE_LIMIT,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!record) throw new Error('Failed to create test record');
      createdIds.push(record.id);

      const result = await checkGuestUsage(db, guestToken, ipHash);

      expect(result.canSend).toBe(false);
      expect(result.messageCount).toBe(GUEST_MESSAGE_LIMIT);
    });

    it('returns canSend=false when message count exceeds limit', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      const [record] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash,
          messageCount: GUEST_MESSAGE_LIMIT + 1,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!record) throw new Error('Failed to create test record');
      createdIds.push(record.id);

      const result = await checkGuestUsage(db, guestToken, ipHash);

      expect(result.canSend).toBe(false);
    });

    it('resets count to 0 and returns canSend=true when resetAt is before today', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      // Create usage record from yesterday at limit
      const [record] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash,
          messageCount: GUEST_MESSAGE_LIMIT,
          resetAt: getYesterdayMidnight(),
        })
        .returning();
      if (!record) throw new Error('Failed to create test record');
      createdIds.push(record.id);

      const result = await checkGuestUsage(db, guestToken, ipHash);

      // Should reset because yesterday < today midnight
      expect(result.canSend).toBe(true);
      expect(result.messageCount).toBe(0);
    });

    it('uses higher message count when both token and IP match different records', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      // Create record with token (2 messages)
      const [record1] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash: 'different-ip',
          messageCount: 2,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!record1) throw new Error('Failed to create test record');
      createdIds.push(record1.id);

      // Create record with IP (4 messages) - this should win
      const [record2] = await db
        .insert(guestUsage)
        .values({
          guestToken: null,
          ipHash,
          messageCount: 4,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!record2) throw new Error('Failed to create test record');
      createdIds.push(record2.id);

      const result = await checkGuestUsage(db, guestToken, ipHash);

      // Should use the higher count (IP record)
      expect(result.messageCount).toBe(4);
      expect(result.canSend).toBe(true);
    });

    it('handles null guestToken by using IP only', async () => {
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      const [record] = await db
        .insert(guestUsage)
        .values({
          guestToken: null,
          ipHash,
          messageCount: 3,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!record) throw new Error('Failed to create test record');
      createdIds.push(record.id);

      const result = await checkGuestUsage(db, null, ipHash);

      expect(result.messageCount).toBe(3);
    });
  });

  describe('incrementGuestUsage', () => {
    it('creates new record for first message', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      const result = await incrementGuestUsage(db, guestToken, ipHash);
      createdIds.push(result.id);

      expect(result.messageCount).toBe(1);

      // Verify in database
      const [record] = await db.select().from(guestUsage).where(eq(guestUsage.id, result.id));
      expect(record?.messageCount).toBe(1);
    });

    it('increments existing record message count', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      // Create existing record
      const [existing] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash,
          messageCount: 2,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!existing) throw new Error('Failed to create test record');
      createdIds.push(existing.id);

      const result = await incrementGuestUsage(db, guestToken, ipHash);

      expect(result.messageCount).toBe(3);
      expect(result.id).toBe(existing.id);
    });

    it('resets and increments when last reset was before today', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      // Create record from yesterday at limit
      const [existing] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash,
          messageCount: GUEST_MESSAGE_LIMIT,
          resetAt: getYesterdayMidnight(),
        })
        .returning();
      if (!existing) throw new Error('Failed to create test record');
      createdIds.push(existing.id);

      const result = await incrementGuestUsage(db, guestToken, ipHash);

      // Should reset to 0 then increment to 1
      expect(result.messageCount).toBe(1);
    });

    it('updates the record with higher message count when both token and IP exist', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      // Create record with token (2 messages)
      const [record1] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash: 'different-ip',
          messageCount: 2,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!record1) throw new Error('Failed to create test record');
      createdIds.push(record1.id);

      // Create record with IP (4 messages) - higher count
      const [record2] = await db
        .insert(guestUsage)
        .values({
          guestToken: null,
          ipHash,
          messageCount: 4,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!record2) throw new Error('Failed to create test record');
      createdIds.push(record2.id);

      const result = await incrementGuestUsage(db, guestToken, ipHash);

      // Should update the IP record (higher count) to 5
      expect(result.messageCount).toBe(5);
      expect(result.id).toBe(record2.id);
    });

    it('uses existingRecord when provided to skip query', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      // Create existing record
      const [existing] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash,
          messageCount: 2,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!existing) throw new Error('Failed to create test record');
      createdIds.push(existing.id);

      // Pass existing record to skip query
      const result = await incrementGuestUsage(db, guestToken, ipHash, {
        id: existing.id,
        messageCount: existing.messageCount,
        resetAt: existing.resetAt,
      });

      expect(result.messageCount).toBe(3);
      expect(result.id).toBe(existing.id);
    });
  });

  describe('checkGuestUsage record passthrough', () => {
    it('returns record in result when guest has existing usage', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      const [existing] = await db
        .insert(guestUsage)
        .values({
          guestToken,
          ipHash,
          messageCount: 2,
          resetAt: getUtcMidnight(),
        })
        .returning();
      if (!existing) throw new Error('Failed to create test record');
      createdIds.push(existing.id);

      const result = await checkGuestUsage(db, guestToken, ipHash);

      expect(result.record).toBeDefined();
      expect(result.record?.id).toBe(existing.id);
      expect(result.record?.messageCount).toBe(2);
    });

    it('returns undefined record for new guest', async () => {
      const guestToken = `test-token-${crypto.randomUUID()}`;
      const ipHash = `test-ip-${crypto.randomUUID()}`;

      const result = await checkGuestUsage(db, guestToken, ipHash);

      expect(result.record).toBeUndefined();
    });
  });
});
