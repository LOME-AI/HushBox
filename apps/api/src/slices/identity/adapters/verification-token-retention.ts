import { inArray, sql } from 'drizzle-orm';
import { verificationTokens } from '@hushbox/db';
import type { DbWriter } from '../../../lib/idempotency/transaction.js';

interface VerificationTokenPurgeParams {
  readonly batchSize: number;
}

/**
 * Deletes one bounded batch of expired verification tokens; returns how many
 * went. These are plaintext bearer credentials, and the consume DELETE matches
 * only unexpired rows — deliberately, since an expired token must never
 * verify — so expiry is what puts a row beyond every other delete path. This
 * pass is the only one that reaches them. There is no grace window: past the
 * expiry the row grants nothing, so keeping it holds a credential nobody can
 * spend. The `expires_at` index backs the scan.
 */
export async function purgeExpiredVerificationTokens(
  writer: DbWriter,
  params: VerificationTokenPurgeParams
): Promise<number> {
  const expired = writer
    .select({ id: verificationTokens.id })
    .from(verificationTokens)
    .where(sql`${verificationTokens.expiresAt} < now()`)
    .limit(params.batchSize);
  const deleted = await writer
    .delete(verificationTokens)
    .where(inArray(verificationTokens.id, expired))
    .returning({ id: verificationTokens.id });
  return deleted.length;
}
