import { eq, or, desc, sql } from 'drizzle-orm';
import { guestUsage, type Database } from '@lome-chat/db';
import { GUEST_MESSAGE_LIMIT, getUtcMidnight, needsResetBeforeMidnight } from '@lome-chat/shared';
import { fireAndForget } from '../../lib/fire-and-forget.js';

export interface GuestUsageCheckResult {
  canSend: boolean;
  messageCount: number;
  limit: number;
  record?: { id: string; messageCount: number; resetAt: Date | null };
}

export interface GuestUsageRecord {
  id: string;
  messageCount: number;
}

/**
 * Find guest usage records by token or IP.
 * Returns the record with the highest message count to catch evasion.
 */
async function findGuestRecord(
  db: Database,
  guestToken: string | null,
  ipHash: string
): Promise<{ id: string; messageCount: number; resetAt: Date | null } | null> {
  const conditions =
    guestToken === null
      ? eq(guestUsage.ipHash, ipHash)
      : or(eq(guestUsage.guestToken, guestToken), eq(guestUsage.ipHash, ipHash));

  const [highest] = await db
    .select()
    .from(guestUsage)
    .where(conditions)
    .orderBy(desc(guestUsage.messageCount))
    .limit(1);

  if (!highest) {
    return null;
  }

  return {
    id: highest.id,
    messageCount: highest.messageCount,
    resetAt: highest.resetAt,
  };
}

/**
 * Check if guest can send messages based on daily limit.
 *
 * @param db - Database connection
 * @param guestToken - Token stored in localStorage (may be null)
 * @param ipHash - SHA-256 hash of IP address
 * @returns Whether guest can send and current message count
 */
export async function checkGuestUsage(
  db: Database,
  guestToken: string | null,
  ipHash: string
): Promise<GuestUsageCheckResult> {
  const record = await findGuestRecord(db, guestToken, ipHash);

  if (!record) {
    return {
      canSend: true,
      messageCount: 0,
      limit: GUEST_MESSAGE_LIMIT,
    };
  }

  let messageCount = record.messageCount;
  let updatedResetAt = record.resetAt;
  if (needsResetBeforeMidnight(record.resetAt)) {
    messageCount = 0;
    updatedResetAt = getUtcMidnight();
    fireAndForget(
      db
        .update(guestUsage)
        .set({
          messageCount: 0,
          resetAt: updatedResetAt,
        })
        .where(eq(guestUsage.id, record.id)),
      'reset guest usage'
    );
  }

  return {
    canSend: messageCount < GUEST_MESSAGE_LIMIT,
    messageCount,
    limit: GUEST_MESSAGE_LIMIT,
    record: {
      id: record.id,
      messageCount,
      resetAt: updatedResetAt,
    },
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code: string }).code === '23505';
}

async function updateRecord(
  db: Database,
  record: { id: string; messageCount: number; resetAt: Date | null }
): Promise<GuestUsageRecord> {
  const shouldReset = needsResetBeforeMidnight(record.resetAt);
  const newCount = shouldReset ? 1 : record.messageCount + 1;

  await db
    .update(guestUsage)
    .set({
      messageCount: newCount,
      resetAt: shouldReset ? getUtcMidnight() : undefined,
    })
    .where(eq(guestUsage.id, record.id));

  return { id: record.id, messageCount: newCount };
}

async function insertWithToken(
  db: Database,
  guestToken: string,
  ipHash: string
): Promise<GuestUsageRecord> {
  const [result] = await db
    .insert(guestUsage)
    .values({ guestToken, ipHash, messageCount: 1, resetAt: getUtcMidnight() })
    .onConflictDoUpdate({
      target: guestUsage.guestToken,
      set: { messageCount: sql`${guestUsage.messageCount} + 1` },
    })
    .returning();

  if (!result) throw new Error('Failed to create guest usage record');
  return { id: result.id, messageCount: result.messageCount };
}

async function insertWithoutToken(db: Database, ipHash: string): Promise<GuestUsageRecord> {
  try {
    const [newRecord] = await db
      .insert(guestUsage)
      .values({ guestToken: null, ipHash, messageCount: 1, resetAt: getUtcMidnight() })
      .returning();

    if (!newRecord) throw new Error('Failed to create guest usage record');
    return { id: newRecord.id, messageCount: 1 };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const retryRecord = await findGuestRecord(db, null, ipHash);
      if (retryRecord) {
        return updateRecord(db, retryRecord);
      }
    }
    throw error;
  }
}

/**
 * Increment guest message count after successful message.
 * Uses atomic upsert when guestToken is provided to prevent race conditions.
 *
 * @param db - Database connection
 * @param guestToken - Token stored in localStorage (may be null)
 * @param ipHash - SHA-256 hash of IP address
 * @param existingRecord - Optional record from checkGuestUsage to skip query
 * @returns Updated usage record
 */
export async function incrementGuestUsage(
  db: Database,
  guestToken: string | null,
  ipHash: string,
  existingRecord?: { id: string; messageCount: number; resetAt: Date | null }
): Promise<GuestUsageRecord> {
  if (existingRecord) {
    return updateRecord(db, existingRecord);
  }

  const record = await findGuestRecord(db, guestToken, ipHash);
  if (record) {
    return updateRecord(db, record);
  }

  if (guestToken) {
    return insertWithToken(db, guestToken, ipHash);
  }

  return insertWithoutToken(db, ipHash);
}
