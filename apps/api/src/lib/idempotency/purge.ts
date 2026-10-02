import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { idempotencyKeys } from '@hushbox/db';
import { IDEMPOTENCY_PURGE_TTL_SECONDS, IDEMPOTENCY_STALE_CLAIM_PURGE_SECONDS } from './config.js';
import { createRetentionEntry } from '../jobs/retention.js';
import type { CronEntry } from '../jobs/cron.js';
import type { DbWriter } from './transaction.js';

export interface IdempotencyPurgeParams {
  readonly batchSize: number;
}

/**
 * The TTL retention delete for key rows, batched so a backlog never holds long
 * locks. A terminal row goes once its `completedAt` passes the purge TTL; a
 * row still `claimed` goes once its `claimedAt` passes the stale-claim
 * horizon, which a live claimant's heartbeat keeps it inside. A zombie whose
 * row is gone finds its completion fence matching nothing and aborts, and read
 * paths never depend on the purge having run. The TTL floor in config.ts
 * guarantees a purged `succeeded` row is already past every replay horizon.
 */
export async function purgeExpiredIdempotencyKeys(
  writer: DbWriter,
  params: IdempotencyPurgeParams
): Promise<number> {
  const expired = writer
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(
      or(
        and(
          isNotNull(idempotencyKeys.completedAt),
          sql`${idempotencyKeys.completedAt} < now() - make_interval(secs => ${IDEMPOTENCY_PURGE_TTL_SECONDS})`
        ),
        and(
          eq(idempotencyKeys.status, 'claimed'),
          sql`${idempotencyKeys.claimedAt} < now() - make_interval(secs => ${IDEMPOTENCY_STALE_CLAIM_PURGE_SECONDS})`
        )
      )
    )
    .limit(params.batchSize);
  const deleted = await writer
    .delete(idempotencyKeys)
    .where(inArray(idempotencyKeys.id, expired))
    .returning({ id: idempotencyKeys.id });
  return deleted.length;
}

/** The daily cron entry for this table's purge, published by the module that owns it. */
export function createIdempotencyKeyPurgeEntry(writer: DbWriter): CronEntry {
  return createRetentionEntry('idempotency-key-purge', (batchSize) =>
    purgeExpiredIdempotencyKeys(writer, { batchSize })
  );
}
