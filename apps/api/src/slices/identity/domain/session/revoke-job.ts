import { z } from 'zod';
import { SESSION_REVOKE_JOB_TYPE, jobOutcome } from '../../../../lib/jobs/index.js';
import { evictUserBestEffort, revokeAllSessions } from './session.js';
import type { JobOutcome, OneShotJobRegistration } from '../../../../lib/jobs/index.js';
import type { EvictUserPort } from '../../ports/index.js';
import type { RedisClient } from '../keys.js';

/**
 * The durable, trigger-neutral session revocation for a userId. The handler is
 * identity-owned (session revocation is identity's concern) while the enqueuers
 * live in whatever slice needs a durable revocation cutoff, which is why the
 * type name sits in the jobs machinery and is re-published here. The row is
 * inserted in the enqueuer's settlement transaction, so the cutoff can never be
 * lost the way a swallowed post-commit best-effort bump was.
 */
export { SESSION_REVOKE_JOB_TYPE } from '../../../../lib/jobs/index.js';

/**
 * Failure budget before the dispatcher dead-letters the row. Only a transient
 * watermark-bump (Redis) failure consumes it; the eviction fan-out is
 * best-effort and never fails the job. A dead row is a jobs-health auditor page
 * — the must-happen guarantee the redesign puts under session revocation.
 */
const SESSION_REVOKE_MAX_FAILURES = 10;

const sessionRevokePayloadSchema = z.object({ userId: z.uuid() });

interface SessionRevokeTargets {
  readonly redis: RedisClient;
  /** Absent when the realtime binding is unavailable (degrades to no eviction). */
  readonly evictUser?: EvictUserPort;
}

interface SessionRevokeJobDeps {
  /** Resolved inside the handler so a config fault is an isolated row failure. */
  readonly resolveRevoke: () => SessionRevokeTargets;
  /** Injected for deterministic watermark assertions; defaults to wall clock. */
  readonly now?: () => number;
}

/**
 * The `session.revoke.v1` handler: the must-happen revocation for every session
 * of a userId, whatever triggered it (a chargeback lock, an admin containment
 * op). It bumps the all-session `passwordChangedAt` watermark — the SOLE cutoff
 * for a user's ALREADY-LIVE sessions and WS (a `users.lockedAt` gate only
 * blocks NEW logins) — then evicts live sockets best-effort. A transient bump
 * failure returns `fail` so the dispatcher retries within seconds, closing the
 * up-to-30-day window a lost bump would have left open.
 *
 * `natural` idempotency: re-running re-bumps the watermark to a fresh `now`,
 * which is idempotent in effect (a revoked account issues no sessions the later
 * watermark should spare, so it still stales exactly the sessions that must
 * die); the eviction is best-effort promptness, backstopped by the fail-closed
 * broadcast-time session-liveness check the watermark drives.
 */
export function createSessionRevokeJobRegistration(
  deps: SessionRevokeJobDeps
): OneShotJobRegistration<typeof sessionRevokePayloadSchema> {
  const now = deps.now ?? ((): number => Date.now());
  return {
    // The watermark bump is one write, and the eviction beside it is one call
    // per member of the user's realtime active-room set — a bound the rooms
    // maintain and expire, and one no constant at this site can show.
    kind: 'oneShot',
    type: SESSION_REVOKE_JOB_TYPE,
    schema: sessionRevokePayloadSchema,
    maxExecutionSeconds: 30,
    maxFailures: SESSION_REVOKE_MAX_FAILURES,
    idempotency: 'natural',
    // The `bulk` shard: the job is enqueued by slices that also enqueue other
    // bulk work (billing's chargeback webhook, account deletion's
    // media.reclaimUser.v1), and the jobs integration harness reserves the
    // `default` shard for committed rows to pass.integration alone. Every
    // enqueue leaves that shard on its transaction's wake collector, so the
    // boundary nudges the `bulk` dispatcher after the commit.
    shard: 'bulk',
    handler: async (execution): Promise<JobOutcome> => {
      const { userId } = execution.payload;
      const { redis, evictUser } = deps.resolveRevoke();
      const revoked = await revokeAllSessions(redis, userId, now());
      if (revoked.isErr()) return jobOutcome.fail(revoked.error.code);
      // Best-effort promptness (never fails the must-happen job — the Result
      // always resolves ok); the watermark bump above is the correctness cutoff
      // the broadcast backstop reads.
      await evictUserBestEffort(evictUser, userId).unwrapOr(null);
      return jobOutcome.ok({ revoked: userId });
    },
  };
}
