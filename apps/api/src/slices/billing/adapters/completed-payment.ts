import { and, eq } from 'drizzle-orm';
import { payments } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Whether this account has ever paid: one `payments` row that reached
 * `completed`. Existence only — the caller asks a yes/no question and is
 * given nothing it did not ask for, so no amount, instant or provider
 * identifier leaves billing through this read.
 *
 * A non-terminal or failed pre-claim is not a payment: money moved only on the
 * completed status, and a caller gating on "has paid" must not fire on a card
 * that was declined.
 */
export function hasCompletedPayment(
  db: Database,
  userId: string
): ResultAsync<boolean, DomainError> {
  return fromPromise(
    db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.userId, userId), eq(payments.status, 'completed')))
      .limit(1),
    (cause) => unavailableError('completed payment read failed', cause)
  ).map((rows) => rows.length > 0);
}
