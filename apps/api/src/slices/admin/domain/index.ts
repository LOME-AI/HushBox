export { createAdminOpEngine } from './engine.js';
export { createAdminOpRegistry } from './registry.js';
export { adminOperations } from './operations/index.js';
export type { AdminOperationsDeps, AdminOperationsPostDeps } from './operations/index.js';
export type {
  AdminOpEngine,
  AdminOpEngineDb,
  AdminOpExecutedNotice,
  AdminOpReadRunResult,
  AdminOpRunResult,
  RunAdminOpParams,
  RunAdminReadParams,
} from './engine.js';
export type { AdminOpPrefill } from './registry.js';
// Deliberately NOT exported: describe-admin-op (the test battery harness —
// imports vitest, test-file consumers only) and fixture-ops (test-only ops).

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor, the
// exemption marker, and the Idempotency-Key header name the execute route
// forwards to the engine — is published here rather than imported from lib
// directly in routes.ts (the account slice's established pattern).
export { createErrorResponse } from '../../../lib/errors/index.js';
export { IDEMPOTENCY_KEY_HEADER, idempotencyExempt } from '../../../lib/idempotency/index.js';
// The issue-body schema the compose preview validates with; routes reach only this barrel.
export { newsletterMarkdownSchema } from '../../notifications/index.js';
export type { Telemetry } from '../../../lib/telemetry/index.js';

// The bespoke read surface (Customer-360, dashboard, jobs queue, audit
// search, SQL panel) — reads skip the op engine but stay audited and
// volume-capped.
/**
 * `loadCustomer360` reaches its callers through `read-surface.ts`, not this
 * line: the line's consumer is `barrel-withheld-exports.test.ts`, which reads
 * this file's text and needs one published name so the absences it asserts
 * beside it are absences rather than an empty read.
 * @toolContract
 */
export { loadCustomer360 } from './customer-360.js';
export type { Customer360Query } from './customer-360.js';
export { createAdminReadSurface } from './read-surface.js';
export type { AdminReadSurface } from './read-surface.js';

// The two cron-facing entries the admin plane owns: the read-only Access-log
// auditor and the daily audit digest (whose cron half only enqueues).
export { createAccessLogAuditEntry } from './access-log-audit.js';
export {
  ADMIN_DIGEST_JOB_TYPE,
  createAdminDigestEnqueueEntry,
  createAdminDigestJobRegistration,
} from './digest.js';
