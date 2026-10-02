import { eq } from 'drizzle-orm';
import { createSharedLink, generateKeyPair } from '@hushbox/crypto';
import { jobs, payments, sharedLinks, users } from '@hushbox/db';
import { insertDeadJob } from '../lib/jobs/index.js';
import { insertRevokedSharedLink } from '../slices/conversations/index.js';
import { applyChargebackLock } from '../slices/identity/index.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE } from '../slices/media/index.js';
import { DevSeedError } from './factories.js';
import type { Database } from '@hushbox/db';

/**
 * Dev-seed states for the admin plane's op targets, so every registered op
 * is exercisable end-to-end against a locally seeded DB: `user.unlock` (a
 * chargeback-locked user), `job.redrive` (a dead job), `job.restore` (a
 * discarded job), `share.unrevoke` (a revoked share) — plus the negative
 * wallet `setWalletBalance` seeds separately for `wallet.credit`.
 * Idempotent, and authoritative over the fixed ids it owns: a re-run rewrites
 * its job and share rows back to the seeded state, so drift an admin op left
 * on one cannot outlive the next seed. The chargeback lock is the exception,
 * applied only where absent — a user locked for another reason is left alone.
 * Every state is verified by query before returning — a seed run that cannot
 * produce its states fails loudly.
 *
 * The parameterized helpers below also back the `POST /dev/admin-targets`
 * route (`mint-admin-targets.ts`), which mints the same states under fresh
 * ids per call so parallel E2E specs never race over the fixed set.
 */

const ADMIN_TARGET_DEAD_JOB_ID = '00000000-0000-4000-8000-00000000ad01';
const ADMIN_TARGET_DISCARDED_JOB_ID = '00000000-0000-4000-8000-00000000ad02';
const ADMIN_TARGET_REVOKED_SHARE_ID = '00000000-0000-4000-8000-00000000ad03';

interface SeedAdminTargetsParams {
  /** Existing seeded user to place in the chargeback-locked state. */
  readonly lockedUserEmail: string;
  /** Existing seeded conversation the revoked share hangs off. */
  readonly conversationId: string;
}

interface SeedAdminTargetsSummary {
  readonly lockedUserId: string;
  readonly deadJobId: string;
  readonly discardedJobId: string;
  readonly revokedShareId: string;
}

interface AdminTargetJobParams {
  readonly id: string;
  /** Rides the job payload only; never dereferenced by the dead-job state. */
  readonly payloadUserId: string;
  readonly discarded: boolean;
  /**
   * Rewrites a row already at this id to the fixture's state. The fixed-id
   * seed sets it, because it owns those ids and an admin op run against one
   * otherwise leaves drift no later seed can undo. Absent — the fresh-id
   * minter's case — leaves a conflicting row standing, as it always has.
   */
  readonly reassertExisting?: boolean;
}

/**
 * A dead (optionally discarded) media-reclaim row; a conflicting id is left
 * standing or reasserted, per `reassertExisting`.
 */
export async function insertAdminTargetJob(
  db: Database,
  params: AdminTargetJobParams
): Promise<void> {
  await insertDeadJob(db, {
    id: params.id,
    type: MEDIA_RECLAIM_USER_JOB_TYPE,
    shard: 'bulk',
    // A legal payload by the registered schema: a redrive must be able to
    // succeed (empty key list = the idempotent no-op).
    payload: { userId: params.payloadUserId, storageKeys: [] },
    discarded: params.discarded,
    reassertExisting: params.reassertExisting ?? false,
  });
}

interface AdminTargetRevokedShareParams {
  readonly id: string;
  readonly conversationId: string;
}

/**
 * A revoked shared link carrying the seed's own display name, keyed by a fresh
 * link secret the way a real mint is. A re-seed conflicts on the fixed id and
 * keeps the key pair and hash the first seed stored.
 */
export async function insertAdminTargetRevokedShare(
  db: Database,
  params: AdminTargetRevokedShareParams
): Promise<void> {
  const { linkPublicKey, linkAuthHash } = createSharedLink(generateKeyPair().privateKey, {
    conversationId: params.conversationId,
    epochNumber: 1,
  });
  await insertRevokedSharedLink(db, {
    id: params.id,
    conversationId: params.conversationId,
    linkPublicKey,
    linkAuthHash,
    displayName: 'Seeded revoked share (admin op target)',
  });
}

export async function seedAdminOpTargets(
  db: Database,
  params: SeedAdminTargetsParams
): Promise<SeedAdminTargetsSummary> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, params.lockedUserEmail.toLowerCase()));
  if (user === undefined) {
    throw new DevSeedError(`seed admin targets: user not found: ${params.lockedUserEmail}`);
  }

  await applyChargebackLock(db, user.id);
  await insertAdminTargetJob(db, {
    id: ADMIN_TARGET_DEAD_JOB_ID,
    payloadUserId: user.id,
    discarded: false,
    reassertExisting: true,
  });
  await insertAdminTargetJob(db, {
    id: ADMIN_TARGET_DISCARDED_JOB_ID,
    payloadUserId: user.id,
    discarded: true,
    reassertExisting: true,
  });
  await insertAdminTargetRevokedShare(db, {
    id: ADMIN_TARGET_REVOKED_SHARE_ID,
    conversationId: params.conversationId,
  });

  await verifyChargebackLock(db, user.id);
  await verifyAdminTargetJob(db, ADMIN_TARGET_DEAD_JOB_ID, false);
  await verifyAdminTargetJob(db, ADMIN_TARGET_DISCARDED_JOB_ID, true);
  await verifyAdminTargetRevokedShare(db, ADMIN_TARGET_REVOKED_SHARE_ID);
  return {
    lockedUserId: user.id,
    deadJobId: ADMIN_TARGET_DEAD_JOB_ID,
    discardedJobId: ADMIN_TARGET_DISCARDED_JOB_ID,
    revokedShareId: ADMIN_TARGET_REVOKED_SHARE_ID,
  };
}

function assertState(present: boolean, state: string): void {
  if (!present) {
    throw new DevSeedError(`seed admin targets: ${state} state missing after seed`);
  }
}

/** Post-seed assertion: the target user is chargeback-locked. */
export async function verifyChargebackLock(db: Database, userId: string): Promise<void> {
  const [locked] = await db
    .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
    .from(users)
    .where(eq(users.id, userId));
  assertState(locked?.lockedAt != null && locked.lockReason === 'chargeback', 'chargeback lock');
}

/** Post-seed assertion: the job row is dead, with the expected disposition. */
export async function verifyAdminTargetJob(
  db: Database,
  id: string,
  discarded: boolean
): Promise<void> {
  const [row] = await db
    .select({ status: jobs.status, discardedAt: jobs.discardedAt })
    .from(jobs)
    .where(eq(jobs.id, id));
  const disposition = discarded ? row?.discardedAt !== null : row?.discardedAt === null;
  assertState(row?.status === 'dead' && disposition, discarded ? 'discarded job' : 'dead job');
}

/**
 * Post-mint assertion: the payment sits at `awaiting_webhook`. Only the
 * fresh-id minter produces this state — a fixed target would have to hang off
 * a shared seeded persona, where an unresolved row counts against that
 * persona's in-flight-deposit guard for the whole E2E suite.
 */
export async function verifyAdminTargetPayment(db: Database, id: string): Promise<void> {
  const [row] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.id, id));
  assertState(row?.status === 'awaiting_webhook', 'awaiting-webhook payment');
}

/** Post-seed assertion: the shared link is revoked. */
export async function verifyAdminTargetRevokedShare(db: Database, id: string): Promise<void> {
  const [share] = await db
    .select({ revokedAt: sharedLinks.revokedAt })
    .from(sharedLinks)
    .where(eq(sharedLinks.id, id));
  assertState(share?.revokedAt != null, 'revoked share');
}
