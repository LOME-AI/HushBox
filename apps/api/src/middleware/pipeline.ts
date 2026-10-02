import { pipelineEnv } from './pipeline-env.js';
import { pipelineCachePolicy } from './pipeline-cache-policy.js';
import { pipelineBindings } from './pipeline-bindings.js';
import { pipelineSession } from './pipeline-session.js';
import { pipelineAdmin } from './pipeline-admin.js';
import { pipelineAuthorize } from './pipeline-authorize.js';
import { pipelineRateLimit } from './pipeline-rate-limit.js';
import { markPipelineHandler } from './pipeline-markers.js';
import { idempotencyKeyStage } from '../lib/idempotency/index.js';
import type { PipelineAdminOptions } from './pipeline-admin.js';
import type { PipelineCachePolicyOptions } from './pipeline-cache-policy.js';
import type { PipelineRateLimitOptions } from './pipeline-rate-limit.js';
import type { PipelineSessionOptions } from './pipeline-session.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Hono, Schema } from 'hono';

interface PipelineOptions {
  /**
   * Session-stage composition (the injected revocation check). The
   * composition root passes the identity slice's implementation here;
   * omitting it leaves principal resolution purely cookie-derived.
   */
  readonly session?: PipelineSessionOptions;
  /**
   * Posture-stage composition (the route-keyed posture map). The composition
   * root passes its own map here; omitting it leaves every matched route
   * admitted, which production refuses.
   */
  readonly rateLimit?: PipelineRateLimitOptions;
  /**
   * Cache-policy-stage composition (the route-keyed policy map). The
   * composition root passes its own map here; outside production, omitting it
   * leaves every response's `Cache-Control` as its handler left it. Production
   * refuses the omission outright.
   */
  readonly cache?: PipelineCachePolicyOptions;
  /**
   * Admin-stage composition (the route-keyed role map). The composition root
   * passes its own map here; omitting it refuses every admin route for every
   * role, which is the fail-closed default this control exists for.
   */
  readonly admin?: PipelineAdminOptions;
}

/**
 * The one per-request chain, applied by the app assembly to EVERYTHING mounted under
 * it. The order is load-bearing:
 *
 * 1. `pipelineEnv` — envUtils first, because every later stage branches on
 *    mode (dev DB config, cookie security flags, dev-only routes) and
 *    CODE-RULES allows env detection only through envUtils.
 * 2. `pipelineCachePolicy` — default-deny cacheability, written on the
 *    unwind. Needs the mode (1) for its unwired-map fail-fast, and sits
 *    ahead of every stage that can answer on its own so a 403, a 429 and a
 *    400 are all forced non-storable alongside the handler's own response.
 *    It cannot move outside `applyPipeline`, so the `edgeRing` mounted ahead
 *    of the pipeline stays outside its reach.
 * 3. `pipelineBindings` — fail-fast binding validation + per-request DI
 *    (bindings, db, redis, logger). Runs before any auth logic so a
 *    misconfigured deployment dies with a named-binding defect instead of a
 *    mid-auth crash, and so the session stage reads the VALIDATED secret.
 * 4. `pipelineSession` — principal resolution from the session cookie; needs
 *    the validated secret (3) and the production flag (1).
 * 5. `pipelineAdmin` — admin-actor resolution from the Cloudflare Access
 *    assertion, ONLY on `admin`-classed routes (a pass-through everywhere
 *    else). Runs after the session stage so its verified principal OVERRIDES
 *    any cookie-derived one (an admin request carries no session cookie, and
 *    a session must never authorize an admin route), and before the
 *    authorizer, which requires the `admin-actor` kind for the class.
 * 6. `pipelineAuthorize` — default-deny route-class enforcement; needs the
 *    principal (4/5) and must be the last authorization gate before any
 *    handler.
 * 7. `pipelineRateLimit` — default-deny rate-limit posture enforcement; runs
 *    after authorization (6) so a request denied for who it is never reaches
 *    a counter, and before the idempotency stage (8) so a refusal costs
 *    nothing and reveals no mutation contract.
 * 8. `idempotencyKeyStage` — Idempotency-Key enforcement on mutating routes;
 *    runs after authorization (6) so an unauthorized request is denied (403)
 *    before any missing-key error (400) reveals a route's mutation contract.
 *
 * Each stage asserts its prerequisites, so a mis-ordered composition fails
 * loudly on the first request rather than silently skipping a gate.
 */
export function applyPipeline<S extends Schema, P extends string>(
  app: Hono<AppEnv, S, P>,
  options?: PipelineOptions
): Hono<AppEnv, S, P> {
  app.use('*', pipelineEnv());
  app.use('*', pipelineCachePolicy(options?.cache));
  app.use('*', pipelineBindings());
  app.use('*', pipelineSession(options?.session));
  app.use('*', pipelineAdmin(options?.admin));
  app.use('*', pipelineAuthorize());
  app.use('*', pipelineRateLimit(options?.rateLimit));
  // Marked pipeline-owned here (the lib module may not import middleware):
  // unmarked, the authorizer would count this wildcard as a matched
  // undeclared handler and default-deny unknown paths instead of 404ing.
  app.use('*', markPipelineHandler(idempotencyKeyStage()));
  return app;
}
