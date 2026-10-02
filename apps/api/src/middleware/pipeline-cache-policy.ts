import { cacheDirectives } from '../lib/cache-policy/index.js';
import { matchedRouteKeys } from '../lib/context/index.js';
import { markPipelineHandler, readPipelineVariable } from './pipeline-markers.js';
import type { CacheDirectives, CachePolicy } from '../lib/cache-policy/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * The declarations, keyed `${method} ${path}` exactly as the router reports a
 * registration. The composition root owns the map and its completeness
 * witness; this stage only reads it, so it takes the widest key type a lookup
 * needs rather than re-deriving the route union.
 */
export type CachePolicyMap = Readonly<Record<string, CachePolicy>>;

export interface PipelineCachePolicyOptions {
  /**
   * The policy map, injected by the composition root (the map is keyed off
   * `AppType`, which middleware may not import). Outside production, omitting
   * it leaves every response's `Cache-Control` untouched — safe only for a
   * surface that mounts no production route, which is why
   * {@link refuseThenFailFastInProduction} refuses the omission there.
   */
  readonly policies?: CachePolicyMap;
}

/** The refusal, rendered once from the vocabulary rather than written out. */
const NO_STORE: CacheDirectives = cacheDirectives({ kind: 'no-store' });

/**
 * What this response may be stored as. Every branch that is not an unambiguous
 * storable declaration resolves to the refusal:
 *
 * - a status other than 200, because a policy licenses one body and an error,
 *   a redirect or a throttle is not it;
 * - an empty match set, because a path that 404s today and becomes a route
 *   tomorrow would otherwise keep serving the stored 404 per colo until the
 *   platform's heuristic TTL expires;
 * - any matched registration the map does not declare;
 * - matched registrations that disagree, since the router picks the responder
 *   after this stage has run and only the fail-closed reading is sound.
 */
function resolveDirectives(c: Context<AppEnv>, policies: CachePolicyMap): CacheDirectives {
  if (c.res.status !== 200) return NO_STORE;
  const rendered = matchedRouteKeys(c).map((key) => {
    const policy = policies[key];
    return policy === undefined ? NO_STORE : cacheDirectives(policy);
  });
  const [first, ...rest] = rendered;
  if (first === undefined) return NO_STORE;
  return rest.every(
    (directives) =>
      directives.cacheControl === first.cacheControl && directives.cacheTag === first.cacheTag
  )
    ? first
    : NO_STORE;
}

/**
 * A completed protocol switch, which this stage must hand back exactly as the
 * handler produced it. The realtime and trial upgrades proxy a Durable
 * Object's `101` with the client-side socket riding on it, and the platform
 * never caches a request carrying `Upgrade: websocket` however it is
 * answered — so there is nothing to declare here and no reason to touch an
 * object whose header mutability is the runtime's business rather than ours.
 */
function isProtocolSwitch(response: Response): boolean {
  return response.status === 101;
}

/**
 * Replaces whatever the handler declared. A handler cannot opt its route in by
 * omission or by setting its own header, and the purge tag is cleared with the
 * storable state it belongs to — a tag on an unstorable response names an entry
 * that will never exist.
 *
 * Header-write only: it sets and deletes on the response's own `Headers` and
 * never reads, wraps or replaces the body, so a streamed body reaches the
 * caller unbuffered and unread.
 *
 * HIDDEN COUPLING: a `Headers` the runtime itself produced — a response handed
 * back from `fetch`, which for this Worker means a Durable Object's answer to
 * an upgrade — is immutable, and writing to one throws. Nothing reaches here
 * holding one: `pipelineSession` reads `c.res` before the handler runs, and
 * hono replaces an already-materialized `c.res` with a fresh mutable response
 * when the handler's own is assigned. Were that read to go, a room's non-`101`
 * refusal on an upgrade route would answer 500 instead — which is a failing
 * test rather than a production surprise, in
 * `apps/api/src/middleware/pipeline-cache-policy.workers.test.ts`.
 */
function writeDirectives(c: Context<AppEnv>, directives: CacheDirectives): void {
  c.res.headers.set('Cache-Control', directives.cacheControl);
  if (directives.cacheTag === undefined) {
    c.res.headers.delete('Cache-Tag');
  } else {
    c.res.headers.set('Cache-Tag', directives.cacheTag);
  }
}

/**
 * The production fail-fast for the silent-omission footgun: with no map wired,
 * no response carries a policy and the declaration is enforced nowhere. Raises
 * a defect (500) rather than degrading. Deferred past an empty match set for
 * the reason the posture gate defers its own: nothing but the pipeline matched
 * means no such route, which is a 404 rather than a misconfiguration.
 *
 * The refusal is written before the raise because the defect answer is itself
 * a response: the raise never returns here, so a handler that declared itself
 * storable would otherwise have that declaration served on the 500.
 */
function refuseThenFailFastInProduction(
  c: Context<AppEnv>,
  matchedARoute: boolean,
  isProduction: boolean
): void {
  if (!matchedARoute || !isProduction) return;
  writeDirectives(c, NO_STORE);
  throw new Error(
    'pipeline misconfigured: a route is reachable in production with no cache-policy ' +
      'map wired. Pass PipelineCachePolicyOptions.policies at the composition root so ' +
      'an undeclared route is refused storage rather than stored on the platform default.'
  );
}

/**
 * Pipeline stage: DEFAULT-DENY cacheability — the one execution point for
 * the cache-policy declaration, written on the unwind so it sees the response
 * every later stage and every handler actually produced.
 *
 * Shared caching is switched on per Worker and consulted before the Worker
 * runs, so the response header is the whole of the per-route control, and the
 * safety question is entirely what an undeclared route gets. It gets
 * `private, no-store`: a newly added authenticated route defaults to failing
 * to cache rather than to leaking. `no-cache` and `max-age=0` are not
 * substitutes — both store.
 *
 * It sits ahead of authorization, the posture gate and the idempotency stage
 * so their refusals unwind through it: a denial, a throttle and a rejected
 * mutation are all responses a cache must not hold either. It runs INSIDE
 * `applyPipeline`, so a middleware mounted ahead of the pipeline that answers
 * without calling `next()` produces a response this never sees; which statuses
 * those are, and which of them a shared cache would store unbidden, are
 * measured in this module's test rather than asserted here.
 *
 * Two responses it reaches and deliberately does not force: a completed
 * protocol switch, which it hands back untouched ({@link isProtocolSwitch}),
 * and every response at all when no map is wired outside production.
 */
export function pipelineCachePolicy(
  options?: PipelineCachePolicyOptions
): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    // The envUtils type assumes the env stage ran; verify it — a storage gate
    // that cannot read the mode must be a loud defect, not a silent pass.
    const envUtilities = readPipelineVariable(c, 'envUtils');
    if (envUtilities === undefined) {
      throw new Error('pipeline order violated: pipelineCachePolicy requires pipelineEnv first.');
    }
    await next();
    const policies = options?.policies;
    if (policies === undefined) {
      // A defect already answered downstream is the one worth surfacing; this
      // stage raising its own on the unwind would overwrite it.
      if (c.error === undefined) {
        refuseThenFailFastInProduction(
          c,
          matchedRouteKeys(c).length > 0,
          envUtilities.isProduction
        );
      }
      return;
    }
    if (isProtocolSwitch(c.res)) return;
    writeDirectives(c, resolveDirectives(c, policies));
  });
}
