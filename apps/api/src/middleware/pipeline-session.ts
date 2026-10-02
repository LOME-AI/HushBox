import { getIronSession } from 'iron-session';
import { matchedRoutes } from 'hono/route';
import {
  billingPortalCookieOptions,
  bindRequestValue,
  derivePrincipal,
  parseBillingPortalClaims,
  parseSessionClaims,
  respondDomainError,
  sessionCookieOptions,
} from '../lib/context/index.js';
import { unavailableError } from '../lib/errors/index.js';
import {
  isPipelineHandler,
  markPipelineHandler,
  readPipelineVariable,
  readRouteClass,
} from './pipeline-markers.js';
import type {
  AppEnv,
  BillingPortalRevocationCheck,
  Principal,
  RouteClass,
  SessionRevocationCheck,
  Variables,
} from '../lib/context/index.js';
import type { Context, MiddlewareHandler } from 'hono';

// The cookie contracts (names, max ages, sealing options) live in lib/context
// with the claims schemas; re-exported here so existing consumers of the
// session stage keep one import site.

export interface PipelineSessionOptions {
  /**
   * Liveness check injected by the composition root (the identity slice owns
   * the implementation; the middleware never imports slice internals). When
   * present it runs on every request with parseable claims: a revoked
   * session degrades to a `none` principal BEFORE authorization, so every
   * authenticated route class rejects it. When the check itself cannot be
   * answered (Redis down) the stage fails closed with 503 — auth never
   * degrades to trusting an unverifiable cookie.
   */
  readonly revocation?: SessionRevocationCheck;
  /**
   * The same seam for the billing-portal credential, which revokes on its own
   * active key rather than the login session's — so a wired login check says
   * nothing about this one, and each is asserted separately below.
   */
  readonly billingRevocation?: BillingPortalRevocationCheck;
}

/**
 * The route classes an authenticated cookie can authorize: without a
 * revocation check, a revoked or logged-out cookie still admits them. `public`
 * and `dev-only` never consult a live session, so they need no check.
 */
const REVOCATION_GUARDED_CLASSES: ReadonlySet<RouteClass> = new Set([
  'session',
  'pending-2fa',
  'billing-token',
]);

/**
 * The billing-portal credential authorizes exactly one class, so that class
 * alone is what its own revocation check has to be wired for.
 */
const BILLING_GUARDED_CLASSES: ReadonlySet<RouteClass> = new Set(['billing-token']);

/** True when a matched, non-pipeline handler declares one of `classes`. */
function reachesRouteClassIn(c: Context<AppEnv>, classes: ReadonlySet<RouteClass>): boolean {
  for (const route of matchedRoutes(c)) {
    if (isPipelineHandler(route.handler)) continue;
    const cls = readRouteClass(route.handler);
    if (cls !== undefined && classes.has(cls)) return true;
  }
  return false;
}

/**
 * The production fail-fast for the silent-omission footgun: a revocation-guarded
 * route reachable in production with no check wired would let revoked and
 * logged-out cookies still authorize. Throws a defect (500) rather than
 * degrading. Checked at first use because slice routes mount after the pipeline.
 */
function assertRevocationWiredInProduction(
  c: Context<AppEnv>,
  options: PipelineSessionOptions | undefined,
  isProduction: boolean
): void {
  if (!isProduction) return;
  if (options?.revocation === undefined && reachesRouteClassIn(c, REVOCATION_GUARDED_CLASSES)) {
    throw new Error(
      'pipeline misconfigured: an authenticated route class is reachable in production ' +
        'without a session revocation check. Wire PipelineSessionOptions.revocation at the ' +
        'composition root so revoked and logged-out cookies stop authorizing.'
    );
  }
  if (options?.billingRevocation === undefined && reachesRouteClassIn(c, BILLING_GUARDED_CLASSES)) {
    throw new Error(
      'pipeline misconfigured: the billing-token route class is reachable in production ' +
        'without a billing-portal revocation check. Wire ' +
        'PipelineSessionOptions.billingRevocation at the composition root so a revoked ' +
        'handoff credential stops authorizing.'
    );
  }
}

function requireRedis(c: Context<AppEnv>): Variables['redis'] {
  const redis = readPipelineVariable(c, 'redis');
  if (redis === undefined) {
    throw new Error('pipeline order violated: pipelineSession requires pipelineBindings first.');
  }
  return redis;
}

/**
 * Either a resolved principal or the 503 the stage answers when a liveness
 * check could not be answered at all — the fail-closed branch, kept as a value
 * so each credential's resolution reads as one expression.
 */
type Resolution = { readonly principal: Principal } | { readonly refusal: Response };

/**
 * The revoke-and-degrade rule, written once for both credentials: an absent
 * check leaves the parsed value alone, an unanswerable one fails the request
 * closed, and a revoked one degrades to `null` so the principal derived from it
 * is `none` BEFORE authorization runs.
 *
 * The unanswerable check is refused as `unavailable` whatever it failed with,
 * so the request is always answered 503, and its error rides as the cause so
 * the refusal tail can name the store behind it.
 */
async function applyLiveness<TCredential>(
  c: Context<AppEnv>,
  parsed: TCredential | null,
  check:
    | ((redis: Variables['redis'], credential: TCredential) => ReturnType<SessionRevocationCheck>)
    | undefined
): Promise<{ readonly live: TCredential | null } | { readonly refusal: Response }> {
  if (parsed === null || check === undefined) return { live: parsed };
  const liveness = await check(requireRedis(c), parsed);
  if (liveness.isErr()) {
    return {
      refusal: respondDomainError(
        c,
        unavailableError('credential liveness could not be answered', liveness.error)
      ),
    };
  }
  return { live: liveness.value === 'revoked' ? null : parsed };
}

async function resolveLoginPrincipal(
  c: Context<AppEnv>,
  options: PipelineSessionOptions | undefined,
  secret: string,
  isProduction: boolean
): Promise<Resolution> {
  const parsed = parseSessionClaims(
    await getIronSession(c.req.raw, c.res, sessionCookieOptions(secret, isProduction))
  );
  const checked = await applyLiveness(c, parsed, options?.revocation);
  if ('refusal' in checked) return checked;
  return { principal: derivePrincipal(checked.live, Date.now()) };
}

async function resolveBillingPortalPrincipal(
  c: Context<AppEnv>,
  options: PipelineSessionOptions | undefined,
  secret: string,
  isProduction: boolean
): Promise<Resolution> {
  const parsed = parseBillingPortalClaims(
    await getIronSession(c.req.raw, c.res, billingPortalCookieOptions(secret, isProduction))
  );
  const checked = await applyLiveness(c, parsed, options?.billingRevocation);
  if ('refusal' in checked) return checked;
  return {
    principal:
      checked.live === null
        ? { kind: 'none' }
        : { kind: 'billing-portal', credential: checked.live },
  };
}

/**
 * Pipeline stage: principal resolution. Unseals the credentials the request
 * presented, applies the injected revocation checks, and derives the request's
 * principal for the authorizer. An unreadable or invalid cookie is expected
 * external input and degrades to `none` — never a defect.
 *
 * The login cookie is attempted first and the billing-portal cookie only when
 * that yields no principal, which is what makes the login session win when a
 * client holds both: the main app never renders a foreign wallet. One stage
 * unseals both, so there is one place where credentials become a principal and
 * one production fail-fast over it.
 *
 * Omitting a revocation check yields purely cookie-derived principals with
 * no liveness guarantee — safe only for surfaces that mount no authenticated
 * route class. In PRODUCTION that omission is a silent footgun (a revoked
 * cookie would still authorize), so it fails fast at first use of any
 * revocation-guarded route; the check cannot be verified at construction
 * because slice routes mount after the pipeline. Dev/CI/test proceed.
 */
export function pipelineSession(options?: PipelineSessionOptions): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    // The bindings type assumes the bindings stage ran; verify it — the
    // secret below must be the fail-fast-validated one, not a raw env read.
    const bindings = readPipelineVariable(c, 'bindings');
    if (bindings === undefined) {
      throw new Error('pipeline order violated: pipelineSession requires pipelineBindings first.');
    }
    const { isProduction } = c.get('envUtils');
    assertRevocationWiredInProduction(c, options, isProduction);
    const secret = bindings.IRON_SESSION_SECRET;

    const login = await resolveLoginPrincipal(c, options, secret, isProduction);
    if ('refusal' in login) return login.refusal;
    if (login.principal.kind !== 'none') {
      bindRequestValue(c, 'principal', login.principal);
      return next();
    }

    const billing = await resolveBillingPortalPrincipal(c, options, secret, isProduction);
    if ('refusal' in billing) return billing.refusal;
    bindRequestValue(c, 'principal', billing.principal);
    return next();
  });
}

export { BILLING_PORTAL_COOKIE_NAME, SESSION_COOKIE_NAME } from '../lib/context/index.js';
