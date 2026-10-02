import { z } from 'zod';
import type { AdminRole } from '@hushbox/shared';
import type { Redis } from '@upstash/redis';
import type { SessionOptions } from 'iron-session';
import type { DomainError } from '../errors/index.js';
import type { ResultAsync } from '../result/index.js';

/**
 * The session cookie contract inherited from the pre-rewrite app: same name,
 * same iron-session sealing, same options — so existing user cookies keep
 * unsealing across the cutover. Lives here (not in the middleware) because
 * both sides of the contract consume it: the pipeline's session stage reads
 * cookies, the identity slice writes them.
 */
export const SESSION_COOKIE_NAME = 'hushbox_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function sessionCookieOptions(secret: string, isProduction: boolean): SessionOptions {
  return {
    password: secret,
    cookieName: SESSION_COOKIE_NAME,
    ttl: SESSION_MAX_AGE_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  };
}

/**
 * The billing-portal handoff cookie: its own name and its own path, so it is
 * a different credential from the login session rather than that session
 * wearing a flag. `Path` is a delivery filter and not a security boundary —
 * the separation is carried by the name, the claims discriminator and the
 * revocation key — but it is what keeps the credential off every route
 * outside the billing surface, so no route needs a guard against seeing one.
 *
 * The path is the API origin's, never the SPA's: the two are different
 * origins, so the SPA's own routes never enter the question.
 */
export const BILLING_PORTAL_COOKIE_NAME = 'hushbox_billing_portal';
export const BILLING_PORTAL_COOKIE_PATH = '/billing';
export const BILLING_PORTAL_MAX_AGE_SECONDS = 60 * 60;

export function billingPortalCookieOptions(secret: string, isProduction: boolean): SessionOptions {
  return {
    password: secret,
    cookieName: BILLING_PORTAL_COOKIE_NAME,
    ttl: BILLING_PORTAL_MAX_AGE_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: BILLING_PORTAL_MAX_AGE_SECONDS,
      path: BILLING_PORTAL_COOKIE_PATH,
    },
  };
}

/**
 * The claims the pipeline reads from the iron-session cookie. The identity
 * slice owns the write side (`identity/domain/session/session.ts` seals the
 * cookie on login). Unknown fields (the legacy writer's email/username) are
 * stripped, which is why `credentialKind` and `billingOnly` are refused here
 * rather than omitted: a stripped key is an ADMITTED payload, so a
 * billing-portal credential — or a pre-separation cookie carrying
 * `billingOnly` — would otherwise unseal here as a full login session. The
 * iron-session seal is not bound to the cookie name, so a credential sealed
 * for the billing cookie unseals under this one whenever both share a secret;
 * the refusal, not the cookie name, is what keeps the two credentials apart.
 */
const sessionClaimsSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  createdAt: z.number(),
  pending2FA: z.boolean(),
  pending2FAExpiresAt: z.number(),
  credentialKind: z.never().optional(),
  billingOnly: z.never().optional(),
});

export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

/**
 * Validates an unsealed session payload (external input — a cookie the client
 * presented). Anything that fails validation is an unauthenticated request,
 * not a defect: forged or stale cookies are expected input, so this fails
 * closed to `null` rather than throwing.
 */
export function parseSessionClaims(value: unknown): SessionClaims | null {
  const parsed = sessionClaimsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The billing-portal handoff credential — a separate cookie from the login
 * session, sharing no field with it but the account it names. The required
 * literal is the whole discrimination: a login payload carries no
 * `credentialKind`, so it can never unseal here even though the seal itself is
 * name-agnostic under a shared secret.
 */
const billingPortalClaimsSchema = z.object({
  credentialKind: z.literal('billing-portal'),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  createdAt: z.number(),
});

export type BillingPortalClaims = z.infer<typeof billingPortalClaimsSchema>;

/**
 * Validates an unsealed billing-portal payload, failing closed to `null` for
 * the same reason {@link parseSessionClaims} does.
 */
export function parseBillingPortalClaims(value: unknown): BillingPortalClaims | null {
  const parsed = billingPortalClaimsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The authenticated identity class of the request, consumed by route-class
 * authorization. Exactly one of:
 * - `none` — no (valid) session;
 * - `pending-2fa` — password verified but TOTP not yet completed; must reach
 *   ONLY `pending-2fa`-class routes among authenticated surfaces, or
 *   login-time 2FA breaks;
 * - `billing-portal` — the mobile → web billing handoff, a credential of its
 *   own rather than a login session wearing a flag: its own cookie, its own
 *   claims schema, its own revocation key. Admitted ONLY to `billing-token`
 *   routes — every other class refuses the kind outright, `public` included,
 *   which costs nothing since anonymous access needs no principal;
 * - `full` — fully authenticated session;
 * - `link-guest` — an unauthenticated visitor holding a shared-link
 *   credential. Never derived from a cookie (`derivePrincipal` cannot
 *   produce it) and admitted to NO route class by the HTTP matrix: the
 *   identity slice's link-credential validation constructs it, and consumers
 *   (realtime WS authz, media presign) authorize against its typed scope —
 *   the link and the one conversation it grants — by matching on the kind.
 * - `admin-actor` — a Cloudflare Access identity verified by the admin JWT
 *   pipeline stage (jose against the Access JWKS: issuer + audience + the
 *   exact-match actor allowlist, fail-closed). Never derived from a cookie
 *   (`derivePrincipal` cannot produce it) and admitted ONLY to `admin`-classed
 *   routes: admins are not product users, so every other class refuses the
 *   kind outright. `email` is the verified Access identity (the audit-row
 *   `actor`); `audience` is the Access-app AUD tag the token verified against;
 *   `role` is the actor's entry in the role map, which the route-roles map and
 *   each operation contract's `allowedRoles` authorize against.
 * - `trial-session` — an unauthenticated visitor running the trial pipeline.
 *   Like `link-guest`, never derived from a cookie and admitted to NO route
 *   class: the trial route constructs it from the `x-trial-token` credential,
 *   and the realtime seam authorizes it against its own trial room (the DO
 *   whose id is the session id) — never a conversation. `sessionId` is a uuid,
 *   so it scopes the trial run's idempotency-key claim.
 */
export type Principal =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending-2fa'; readonly claims: SessionClaims }
  | { readonly kind: 'billing-portal'; readonly credential: BillingPortalClaims }
  | { readonly kind: 'full'; readonly claims: SessionClaims }
  | { readonly kind: 'link-guest'; readonly linkId: string; readonly conversationId: string }
  | {
      readonly kind: 'admin-actor';
      readonly email: string;
      readonly audience: string;
      readonly role: AdminRole;
    }
  | { readonly kind: 'trial-session'; readonly sessionId: string };

/**
 * Maps login claims to a principal. An EXPIRED pending-2FA challenge degrades
 * to `none` — the legacy middleware answered it 401 (re-login required), and
 * the identity slice re-checks expiry domain-side on the verify route. It can
 * yield no `billing-portal`: that credential parses through its own schema and
 * is derived from its own cookie.
 */
export function derivePrincipal(claims: SessionClaims | null, now: number): Principal {
  if (claims === null) return { kind: 'none' };
  if (claims.pending2FA) {
    if (claims.pending2FAExpiresAt < now) return { kind: 'none' };
    return { kind: 'pending-2fa', claims };
  }
  return { kind: 'full', claims };
}

export type SessionLiveness = 'active' | 'revoked';

/**
 * The session-revocation seam the pipeline's session stage runs on every
 * request that presents parseable claims. The implementation lives in the
 * identity slice (it owns the sessionActive / password-changed-at Redis
 * keys) and is injected at the composition root — the middleware never
 * imports slice internals. `revoked` covers both a missing/expired
 * sessionActive key and a cookie issued before the password last changed.
 */
export type SessionRevocationCheck = (
  redis: Redis,
  claims: SessionClaims
) => ResultAsync<SessionLiveness, DomainError>;

/**
 * The billing-portal credential's revocation seam. Separate from
 * {@link SessionRevocationCheck} because the credential revokes on its own
 * active key: wiring one says nothing about the other, and a single seam
 * taking either claims shape would hide that.
 */
export type BillingPortalRevocationCheck = (
  redis: Redis,
  credential: BillingPortalClaims
) => ResultAsync<SessionLiveness, DomainError>;
