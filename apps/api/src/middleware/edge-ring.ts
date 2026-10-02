import { requestScope } from '../lib/context/index.js';
import { cors } from './cors.js';
import { securityHeaders } from './security-headers.js';
import { requestBodyLimit } from './body-limit.js';
import { requestLog } from './request-log.js';
import { versionCheck } from './version-check.js';
import { csrfProtection } from './csrf.js';
import { markPipelineHandler } from './pipeline-markers.js';
import type { AppEnv } from '../lib/context/index.js';
import type { MiddlewareHandler } from 'hono';

/**
 * The middleware the app assembly mounts OUTSIDE `applyPipeline`, in the
 * legacy global order. Every entry is marked pipeline-owned, so the authorizer
 * still 404s an unknown path instead of counting these wildcards as matched
 * undeclared handlers and default-denying it.
 *
 * One sequence rather than a run of mount calls, because this is also the ring
 * the default-deny cache-policy stage cannot reach: an entry that answers
 * without calling `next()` produces a response no pipeline stage writes a
 * header onto, and that stage's test measures which statuses this ring can
 * short-circuit with. Reading the ring from here is what makes a middleware
 * added to it measured rather than invisible.
 *
 * No entry carries state between requests: each is either constructed per
 * call, or — where the handler holds nothing at all — one shared stateless
 * instance.
 */
export function edgeRing(): readonly MiddlewareHandler<AppEnv>[] {
  return [
    // AsyncLocalStorage-backed request scope (nodejs_compat on Workers):
    // composition-root adapters bound as STATIC slice deps (the identity email
    // port) resolve their per-request infra through it at call time. It leads
    // first because every later stage binds into it. What it may and may not
    // hold — and why the answer is a runtime memory property rather than a
    // style choice — is in `apps/api/src/lib/context/request-scope.ts`.
    requestScope(),
    // CORS leads: it answers preflights before any auth stage could reject an
    // OPTIONS request.
    cors(),
    securityHeaders(),
    // Reject oversized bodies before any handler buffers or parses them (413,
    // uniform `{code}`). After security-headers and CORS so the rejection
    // still carries them; ahead of the pipeline so a hostile body never
    // reaches auth or a route.
    requestBodyLimit(),
    requestLog(),
    versionCheck(),
    csrfProtection(),
  ].map((handler) => markPipelineHandler(handler));
}
