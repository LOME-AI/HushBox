import { z } from 'zod';
import { utcDayBounds, utcDayKey } from '@hushbox/shared';
import { DAY_MS } from '@hushbox/shared/durations';
import {
  enqueueWithinTx,
  grantJobWakes,
  jobOutcome,
  runWithJobWakes,
} from '../../../lib/jobs/index.js';
import { adminDailyDigestEmail, renderEmail } from '../../notifications/index.js';
import type { Database } from '@hushbox/db';
import type { AdminDigestAction, BatchEmailSender } from '../../notifications/index.js';
import type { AdminAuditDigestReads, AdminAuditDigestRow } from '../ports/index.js';
import type {
  CronEntry,
  JobOutcome,
  JobRegistry,
  JobWakeCapable,
  OneShotJobRegistration,
} from '../../../lib/jobs/index.js';

/**
 * The daily admin audit digest (telemetry, never a control): one email per
 * allowlisted admin summarizing one full UTC day of `admin_audit` actions.
 *
 * Delivery runs as an `admin.digest.v1` job, never on cron — cron hosts only
 * pollers, retention deletes and read-only auditors (docs/CODE-RULES.md
 * §Jobs & Async), so the cron entry here only enqueues the row.
 */

/** Bounded read — a digest is a summary, never an unbounded table scan. */
export const DIGEST_MAX_ACTIONS = 500;

export const ADMIN_DIGEST_JOB_TYPE = 'admin.digest.v1';

/**
 * Transient send failures only; a permanently unreachable provider exhausts the
 * budget and dead-letters, which the dispatcher captures under the
 * `job_dead_letter` fingerprint at claim time, rather than silently skipping a
 * day. (The stuck-jobs auditor never sees it: it scans `pending`/`running`
 * only, and no attempt of this type is ever due for longer than its grace.)
 */
export const ADMIN_DIGEST_MAX_FAILURES = 5;

/**
 * The day is the unit of work, not the fire time: a retry that crosses midnight
 * must summarize the day it was enqueued for, which is also what lets the
 * provider key below stay stable across every attempt.
 */
const adminDigestPayloadSchema = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    // A regex-valid but non-existent date rolls over rather than failing to
    // parse (`2026-02-30` becomes `2026-03-02`), so the round trip is what
    // catches it. Refused here — at enqueue, inside the caller's transaction —
    // rather than becoming a row that summarizes the wrong window.
    .refine((day) => {
      const parsed = new Date(`${day}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && utcDayKey(parsed) === day;
    }),
});

interface DigestWindow {
  /** The summarized day, `YYYY-MM-DD` (UTC). */
  readonly day: string;
  readonly since: Date;
  readonly until: Date;
}

/** The previous full UTC day relative to the cron's fire time. */
export function previousUtcDay(now: Date): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return utcDayKey(new Date(midnight - DAY_MS));
}

export function digestWindowForDay(day: string): DigestWindow {
  const { start, end } = utcDayBounds(day);
  return { day, since: start, until: end };
}

export interface AdminDigestSendDeps {
  readonly sender: BatchEmailSender;
  readonly adminEmails: readonly string[];
  /** The admin SPA's origin the digest's audit-log link points at. */
  readonly adminUrl: string;
}

interface AdminDigestJobDeps {
  /** The slice's own capped window read over `admin_audit`. */
  readonly auditReads: AdminAuditDigestReads;
  /** Resolved inside the handler so a config fault is an isolated row failure. */
  readonly resolveSend: () => AdminDigestSendDeps;
}

function toDigestActions(rows: readonly AdminAuditDigestRow[]): AdminDigestAction[] {
  return rows.map((row) => ({
    opName: row.action,
    actorEmail: row.actor,
    ...(row.targetType === null || row.targetId === null
      ? {}
      : { target: { type: row.targetType, id: row.targetId } }),
    occurredAt: row.createdAt.toISOString(),
  }));
}

/**
 * `admin.digest.v1` — one day's digest to every allowlisted admin.
 *
 * `providerKey` class: the whole recipient list ships as one batch under the
 * day-derived `admin.digest.v1:{day}` Idempotency-Key, so a redelivered row
 * replays the original accepted request at the provider and delivers at most
 * once per recipient. The key is derived from the payload day rather than the
 * jobId deliberately — a jobId-derived key would let a duplicate cron
 * invocation that enqueued a *second* row for the same day send the digest
 * twice, which the day-derived key also closes.
 */
export function createAdminDigestJobRegistration(
  deps: AdminDigestJobDeps
): OneShotJobRegistration<typeof adminDigestPayloadSchema> {
  return {
    kind: 'oneShot',
    type: ADMIN_DIGEST_JOB_TYPE,
    schema: adminDigestPayloadSchema,
    maxExecutionSeconds: 60,
    maxFailures: ADMIN_DIGEST_MAX_FAILURES,
    idempotency: 'providerKey',
    shard: 'bulk',
    handler: async (execution): Promise<JobOutcome> => {
      const { day } = execution.payload;
      const { sender, adminEmails, adminUrl } = deps.resolveSend();
      if (adminEmails.length === 0) return jobOutcome.ok({ recipients: 0, day });

      const window = digestWindowForDay(day);
      const actions = toDigestActions(
        await deps.auditReads.actionsInWindow(window, DIGEST_MAX_ACTIONS)
      );
      // Dated by the window it summarizes, never the clock: every attempt replays
      // under one provider key, so every attempt must render the same bytes.
      const email = renderEmail(
        adminDailyDigestEmail,
        { day, actions, adminUrl },
        { sentAt: window.until }
      );
      const sent = await sender.sendBatch(
        adminEmails.map((to) => ({
          to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        })),
        { idempotencyKey: `${ADMIN_DIGEST_JOB_TYPE}:${day}` }
      );
      return sent.isErr()
        ? jobOutcome.fail(sent.error.code)
        : jobOutcome.ok({ recipients: adminEmails.length, day });
    },
  };
}

interface AdminDigestEnqueueDeps {
  /** Capability-bearing so the enqueue leaves its wake on the cron's scope. */
  readonly db: JobWakeCapable<Database>;
  /**
   * Supplies the registered schema/lease/shard the enqueue reads. Resolved
   * inside `run` so a config fault is an isolated entry failure (the cron
   * surface's resolver precedent) and surfaces as a failed enqueue rather than
   * a row that can never succeed.
   */
  readonly resolveRegistry: () => JobRegistry;
  readonly now: () => Date;
}

/**
 * The cron half: an INSERT in its own transaction and nothing else. The
 * day-keyed `dedupeKey` covers a duplicate cron invocation while the row is
 * still pending or running; the provider key above covers redelivery of the
 * row itself. The enqueue leaves its shard on the pass-scoped handle's
 * collector; the cron handler discharges it after this transaction commits.
 */
export function createAdminDigestEnqueueEntry(deps: AdminDigestEnqueueDeps): CronEntry {
  return {
    name: 'admin-daily-digest-enqueue',
    run: async (): Promise<void> => {
      const registry = deps.resolveRegistry();
      const day = previousUtcDay(deps.now());
      await runWithJobWakes(deps.db, (collected) =>
        deps.db.transaction((tx) =>
          enqueueWithinTx(grantJobWakes(tx, collected), registry, {
            type: ADMIN_DIGEST_JOB_TYPE,
            payload: { day },
            dedupeKey: `${ADMIN_DIGEST_JOB_TYPE}:${day}`,
          })
        )
      );
    },
  };
}
