import { and, eq, isNull } from 'drizzle-orm';
import { users } from '@hushbox/db';
import type { Database } from '@hushbox/db';

/**
 * Dev/E2E fixture writes to `users`, published on the barrel so the dev
 * tooling puts an account into a fixture state through the slice that owns
 * the table rather than writing it from outside.
 */

/**
 * Chargeback lock, applied only when unlocked (re-runs keep the original
 * lockedAt; the paired-nullability check constraint stays satisfied).
 */
export async function applyChargebackLock(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ lockedAt: new Date(), lockReason: 'chargeback' })
    .where(and(eq(users.id, userId), isNull(users.lockedAt)));
}

interface SetEmailVerifiedParams {
  readonly email: string;
  /** The persona record's value — the seed's authoritative answer, not a delta. */
  readonly verified: boolean;
}

/**
 * Re-assert a seeded persona's `emailVerified` from its persona record.
 *
 * `mintSeedUser` is skip-if-exists, so its created-branch verification is the
 * only time the flag is applied; without this, a run that verifies a seeded
 * persona (an E2E verify-email journey) leaves that persona verified for every
 * later seed. Writing the column directly is deliberate: the token path is
 * single-use and one-way, so it cannot express "unverified".
 */
export async function setEmailVerified(
  db: Database,
  params: SetEmailVerifiedParams
): Promise<void> {
  const updated = await db
    .update(users)
    .set({ emailVerified: params.verified })
    .where(eq(users.email, params.email.toLowerCase()))
    .returning({ id: users.id });
  if (updated.length === 0) {
    throw new Error(`identity dev fixtures: no user to set emailVerified for ${params.email}`);
  }
}

interface SetAccountCreatedAtParams {
  readonly email: string;
  /** The instant the account is dated to; the growth views bucket their weeks off it. */
  readonly createdAt: Date;
}

/**
 * Date a seeded account back to the instant its cohort belongs at.
 *
 * The registration path cannot express this and is not asked to: the account
 * row's creation instant is the column default, stamped by the transaction that
 * writes the row, and the values registration takes carry no instant at all.
 * The cohort grid, the ladder's account steps and the self-reported sources
 * panel all bucket by that column, so a seed that left every account at the
 * instant it ran would put twelve weeks of signups in one week.
 *
 * Rewriting rather than offsetting, so a re-run lands on the value the row
 * already holds instead of walking it further back each time.
 */
export async function setAccountCreatedAt(
  db: Database,
  params: SetAccountCreatedAtParams
): Promise<void> {
  const updated = await db
    .update(users)
    .set({ createdAt: params.createdAt })
    .where(eq(users.email, params.email.toLowerCase()))
    .returning({ id: users.id });
  if (updated.length === 0) {
    throw new Error(`identity dev fixtures: no account to date back for ${params.email}`);
  }
}
