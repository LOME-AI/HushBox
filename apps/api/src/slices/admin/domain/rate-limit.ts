import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The admin plane's named volume caps: its sensitive read surfaces (Charter
 * #12: metadata reads are scoped, audited, and volume-capped) and its
 * operations surface. Counted at the edge by the pipeline rate-limit stage,
 * under the `admin-actor` identity this slice's posture fragment declares,
 * keyed per hashed admin actor. Windows are sized for 1–3 founder-admins
 * working a console — generous for real use, prohibitive for bulk
 * exfiltration. Throttles: an actor hash is not a secret being guessed, so
 * none of them clears on success. A window that has a dev reset has its OWN,
 * reaching that window alone; the reset function in
 * `apps/api/src/dev/redis-resets.ts` states why that window has one.
 */

/** Customer-360 loads: each is a whole-customer metadata assembly. */
export const adminCustomer360RateLimit = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 3600,
  buildKey: (actorHash: string) => `ratelimit:admin:read:customer360:${actorHash}`,
} as const satisfies ThrottleLimit;

/** Audit-trail searches (the trail names users as targets). */
export const adminAuditSearchRateLimit = {
  kind: 'throttle',
  maxAttempts: 240,
  windowSeconds: 3600,
  buildKey: (actorHash: string) => `ratelimit:admin:read:audit:${actorHash}`,
} as const satisfies ThrottleLimit;

/**
 * The dashboard's recent-actions feed, which serves `admin_audit` rows — actor,
 * target type, target id — from the same table the audit search reads. Sized at
 * the audit search's own cap and window because it is the same table under the
 * same actor identity, and it is a strictly tighter bound on rows: the feed is
 * a fixed newest-N with no cursor and no filters, where a search page is larger
 * and can page back through the whole trail.
 */
export const adminDashboardRateLimit = {
  kind: 'throttle',
  maxAttempts: 240,
  windowSeconds: 3600,
  buildKey: (actorHash: string) => `ratelimit:admin:read:dashboard:${actorHash}`,
} as const satisfies ThrottleLimit;

/**
 * The job-queue read. Sized from the audit search's cap by holding the hourly
 * ROW ceiling equal rather than the request count: an audit page is capped at
 * 100 rows and a job page at 200, so half the requests buy the same rows out
 * (240 × 100 = 120 × 200). Equal is the ceiling and not the floor for this
 * surface — `payload` passes a job's payload through verbatim, and a
 * media-reclaim payload carries a user id plus storage keys that embed
 * conversation and message ids, so a row here discloses at least as much as an
 * audit row does.
 */
export const adminJobQueueRateLimit = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 3600,
  buildKey: (actorHash: string) => `ratelimit:admin:read:jobs:${actorHash}`,
} as const satisfies ThrottleLimit;

/** Feedback triage reads (inbox pages and audited detail loads name users). */
export const adminFeedbackRateLimit = {
  kind: 'throttle',
  maxAttempts: 240,
  windowSeconds: 3600,
  buildKey: (actorHash: string) => `ratelimit:admin:read:feedback:${actorHash}`,
} as const satisfies ThrottleLimit;

/** Newsletter subscriber consent-evidence pages (per-person PII reads). */
export const adminNewsletterSubscribersRateLimit = {
  kind: 'throttle',
  maxAttempts: 240,
  windowSeconds: 3600,
  buildKey: (actorHash: string) => `ratelimit:admin:read:newsletter-subscribers:${actorHash}`,
} as const satisfies ThrottleLimit;

/** SQL panel queries — psql-grade reads; the row cap bounds each page. */
export const adminSqlPanelRateLimit = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 3600,
  buildKey: (actorHash: string) => `ratelimit:admin:read:sql:${actorHash}`,
} as const satisfies ThrottleLimit;

/**
 * Operation runs — preview and execute on ONE window, so an actor's total op
 * activity is bounded across the pair and preview is not the free half of it.
 * Preview is a sensitive read under Charter #12: it returns the effects an op
 * body computed against real customer rows, and it writes a read-audit row.
 * Execute is the plane's mutation surface, where the idempotency-key row
 * fences replay of one operation and not volume — a fresh key per call is
 * free. Sized at the Customer-360 cap, the other whole-customer-state surface:
 * nothing measured exists to size any cap in this file from, because nothing
 * retains the log lines this Worker writes, so sibling parity is the best
 * evidence available.
 */
export const adminOpsRateLimit = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 3600,
  buildKey: (actorHash: string) => `ratelimit:admin:ops:${actorHash}`,
} as const satisfies ThrottleLimit;
