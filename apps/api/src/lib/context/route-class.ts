import { match } from 'ts-pattern';
import { STATUS_BY_DOMAIN_CODE } from './domain-error-status.js';
import type { Principal } from './principal.js';
import type { DomainErrorCode } from '../errors/index.js';

/**
 * The closed set of route classes. EVERY route mounted under the app must
 * declare exactly one; an undeclared route is denied by the pipeline
 * (default-deny). Derived from the legacy app's auth surface:
 * - `public` — unauthenticated reads/entry points (health, trial, shares,
 *   webhooks, public roadmap);
 * - `session` — a full session required (the legacy `sessionMiddleware`
 *   surface: conversations, chat, billing-adjacent CRUD, …);
 * - `pending-2fa` — auth-flow routes that MUST stay reachable while a session
 *   is mid-2FA (login/2fa/verify and the legacy `/api/auth/*` mounts that
 *   deliberately skipped `sessionMiddleware`);
 * - `billing-token` — the mobile → web billing handoff surface; admits the
 *   `billing-portal` credential in addition to full sessions, which the in-app
 *   billing page and the composer's funding read reach it with;
 * - `dev-only` — hidden (404) in production, open otherwise;
 * - `admin` — the admin plane's HTTP surface (`slices/admin`): requires the
 *   `admin-actor` principal minted by the admin JWT pipeline stage (Cloudflare
 *   Access assertion verified in-Worker — the belt behind the Access edge
 *   wall). No session-derived principal ever passes it.
 */
export const ROUTE_CLASSES = [
  'public',
  'session',
  'pending-2fa',
  'billing-token',
  'dev-only',
  'admin',
] as const;

export type RouteClass = (typeof ROUTE_CLASSES)[number];

/**
 * A refusal names a domain code; its status comes from the one map. Both fields
 * span the whole taxonomy rather than the three codes this gate happens to
 * reach today — the deliberate price of holding no code→status pair here, since
 * any narrower pairing would be a second expression of the map.
 */
type AccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly status: (typeof STATUS_BY_DOMAIN_CODE)[DomainErrorCode];
      readonly code: DomainErrorCode;
    };

const ALLOWED: AccessDecision = { allowed: true };

function deny(code: DomainErrorCode): AccessDecision {
  return { allowed: false, status: STATUS_BY_DOMAIN_CODE[code], code };
}

/** A caller with no session is unauthenticated; a half-authenticated one is forbidden. */
function denyByPrincipal(principal: Principal): AccessDecision {
  return principal.kind === 'none' ? deny('unauthorized') : deny('forbidden');
}

/**
 * The authorization matrix — the single decision point for route-class
 * enforcement. `undefined` means the matched route declared no class: that is
 * default-deny (forbidden for everyone, including full sessions), not merely
 * unauthenticated.
 *
 * A `pending-2fa` principal passes only `public`, `pending-2fa`, and non-prod
 * `dev-only` — i.e. exactly the anonymous surface plus its own route class —
 * so a password-only session can never act as an authenticated one.
 */
export function authorizeAccess(
  routeClass: RouteClass | undefined,
  principal: Principal,
  env: { readonly isProduction: boolean }
): AccessDecision {
  if (routeClass === undefined) return deny('forbidden');
  // The HTTP matrix admits NO link-guest or trial-session: the pipeline never
  // derives either from a cookie, so one reaching this gate is out-of-band by
  // construction and fails closed — even on `public`, which costs a guest
  // nothing (anonymous HTTP access needs no principal). Their authorization
  // happens at the realtime/media seams by typed match on the principal (a
  // link-guest against its conversation, a trial-session against its own trial
  // room), never through route classes.
  if (principal.kind === 'link-guest' || principal.kind === 'trial-session')
    return deny('forbidden');
  // Admins are not product users (ARCHITECTURE §Admin plane): the admin-actor principal
  // authorizes ONLY `admin`-classed routes, and no other principal kind can
  // reach them — a full product session on an admin route is forbidden, an
  // anonymous caller unauthorized (the JWT stage already answered 401 for a
  // presented-but-invalid assertion before this gate runs).
  if (principal.kind === 'admin-actor') {
    return routeClass === 'admin' ? ALLOWED : deny('forbidden');
  }
  // The billing-portal credential is scoped to one class the way admin-actor
  // is: a cookie path keeps it off other routes as a delivery filter, and this
  // is the authorization that does not depend on the path holding.
  if (principal.kind === 'billing-portal') {
    return routeClass === 'billing-token' ? ALLOWED : deny('forbidden');
  }
  return (
    match(routeClass)
      // Only the admin-actor early return above passes `admin`; every
      // session-derived principal is refused here.
      .with('admin', () => denyByPrincipal(principal))
      .with('public', () => ALLOWED)
      .with('pending-2fa', () => ALLOWED)
      .with('dev-only', () => (env.isProduction ? deny('not_found') : ALLOWED))
      .with('session', () => (principal.kind === 'full' ? ALLOWED : denyByPrincipal(principal)))
      .with('billing-token', () =>
        principal.kind === 'full' ? ALLOWED : denyByPrincipal(principal)
      )
      .exhaustive()
  );
}
