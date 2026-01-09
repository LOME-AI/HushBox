import { eq, or } from 'drizzle-orm';
import { guestUsage, type Database } from '@lome-chat/db';
import { GUEST_MESSAGE_LIMIT } from '@lome-chat/shared';

export interface GuestUsageCheckResult {
  canSend: boolean;
  messageCount: number;
  limit: number;
}

export interface GuestUsageRecord {
  id: string;
  messageCount: number;
}

/**
 * Get the start of the current UTC day.
 */
function getUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Check if usage needs to be reset (lazy reset at UTC midnight).
 */
function needsReset(resetAt: Date | null): boolean {
  if (resetAt === null) {
    return true;
  }
  const midnight = getUtcMidnight();
  return resetAt < midnight;
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
  // Build OR condition
  const conditions =
    guestToken !== null
      ? or(eq(guestUsage.guestToken, guestToken), eq(guestUsage.ipHash, ipHash))
      : eq(guestUsage.ipHash, ipHash);

  const records = await db.select().from(guestUsage).where(conditions);

  if (records.length === 0) {
    return null;
  }

  // Return record with highest message count
  let highest = records[0];
  if (!highest) return null;
  for (const record of records) {
    if (record.messageCount > highest.messageCount) {
      highest = record;
    }
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

  // Check if needs reset
  let messageCount = record.messageCount;
  if (needsReset(record.resetAt)) {
    messageCount = 0;
    // Update the reset in database (fire-and-forget)
    void db
      .update(guestUsage)
      .set({
        messageCount: 0,
        resetAt: getUtcMidnight(),
      })
      .where(eq(guestUsage.id, record.id))
      .catch((err: unknown) => {
        console.error('Failed to reset guest usage:', err);
      });
  }

  return {
    canSend: messageCount < GUEST_MESSAGE_LIMIT,
    messageCount,
    limit: GUEST_MESSAGE_LIMIT,
  };
}

/**
 * Increment guest message count after successful message.
 *
 * @param db - Database connection
 * @param guestToken - Token stored in localStorage (may be null)
 * @param ipHash - SHA-256 hash of IP address
 * @returns Updated usage record
 */
export async function incrementGuestUsage(
  db: Database,
  guestToken: string | null,
  ipHash: string
): Promise<GuestUsageRecord> {
  const record = await findGuestRecord(db, guestToken, ipHash);

  if (!record) {
    // Create new record
    const [newRecord] = await db
      .insert(guestUsage)
      .values({
        guestToken,
        ipHash,
        messageCount: 1,
        resetAt: getUtcMidnight(),
      })
      .returning();

    if (!newRecord) throw new Error('Failed to create guest usage record');
    return {
      id: newRecord.id,
      messageCount: 1,
    };
  }

  // Check if needs reset
  const shouldReset = needsReset(record.resetAt);
  const newCount = shouldReset ? 1 : record.messageCount + 1;

  // Update existing record
  await db
    .update(guestUsage)
    .set({
      messageCount: newCount,
      resetAt: shouldReset ? getUtcMidnight() : undefined,
    })
    .where(eq(guestUsage.id, record.id));

  return {
    id: record.id,
    messageCount: newCount,
  };
}
