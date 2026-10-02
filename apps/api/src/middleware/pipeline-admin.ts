import { SignJWT, createLocalJWKSet, createRemoteJWKSet, importJWK, jwtVerify } from 'jose';
import { matchedRoutes } from 'hono/route';
import { CF_ACCESS_JWT_HEADER, ERROR_CODES, accessTeamHost } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import {
  bindRequestValue,
  parseAdminActorAllowlist,
  parseAdminRoleMap,
  routeKey,
} from '../lib/context/index.js';
import { FINGERPRINT_CODES } from '../lib/telemetry/index.js';
import {
  isPipelineHandler,
  markPipelineHandler,
  readPipelineVariable,
  readRouteClass,
} from './pipeline-markers.js';
import type { AdminRole, EnvUtilities } from '@hushbox/shared';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { JWTVerifyGetKey } from 'jose';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings, RefusalResponse } from '../lib/context/index.js';

export { CF_ACCESS_JWT_HEADER } from '@hushbox/shared';

/**
 * Accepted JWT algorithms, pinned to whatever the mode's key source can
 * legitimately sign: Access signs RS256; the committed dev fixture key is
 * Ed25519. Pinning per mode — rather than accepting the union — closes
 * algorithm-confusion regardless of what a JWKS response claims.
 */
const PRODUCTION_ALGORITHMS = ['RS256'];
const DEV_ALGORITHMS = ['EdDSA'];

/** Dev-mint token lifetime — long enough for a local session, short enough
 * that a leaked local token is worthless quickly. */
const DEV_TOKEN_LIFETIME_SECONDS = 60 * 60;

/** The Access issuer for a Zero Trust team domain. */
export function accessIssuer(teamDomain: string): string {
  return `https://${accessTeamHost(teamDomain)}`;
}

interface AdminAccessConfig {
  readonly teamDomain: string;
  readonly audience: string;
  /** Lowercased exact-match actor emails. */
  readonly allowlist: ReadonlySet<string>;
  /** Lowercased actor email to the role the plane authorizes it as. */
  readonly roles: ReadonlyMap<string, AdminRole>;
}

/**
 * The route-keyed role declarations, keyed `${method} ${path}` exactly as the
 * router reports a registration — the same shape as the posture and
 * cache-policy maps, and read here rather than re-derived, because the map is
 * keyed off `AppType`, which middleware may not import.
 */
export type AdminRouteRoleMap = Readonly<Record<string, readonly AdminRole[]>>;

export interface PipelineAdminOptions {
  /**
   * The route-to-roles declarations, injected by the composition root. An
   * absent map, and any admin route the map does not declare, is refused for
   * EVERY role including the operator: this stage is the plane's primary
   * authorization control, so a route that forgot to declare must fail closed
   * rather than serve whoever authenticated.
   */
  readonly routeRoles?: AdminRouteRoleMap;
}

/**
 * One required Access binding, or the deployment defect. An absent binding and
 * a blank one are the same misconfiguration; the message names the one that is
 * missing, because the operator reading a 500 has four candidates otherwise.
 */
function requireAccessBinding(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(
      'pipeline misconfigured: an admin-classed route is reachable without Access ' +
        `config (${name} is unset). Set CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, ` +
        'ADMIN_ACTOR_ALLOWLIST, and ADMIN_ROLE_MAP.'
    );
  }
  return value;
}

/**
 * Fail-fast config read, run only when an admin-classed route matched: a
 * deployment that mounts the admin surface without its Access config is a
 * defect (500), never a silently-open or silently-closed route.
 */
function readAdminAccessConfig(env: Bindings): AdminAccessConfig {
  const teamDomain = requireAccessBinding(env.CF_ACCESS_TEAM_DOMAIN, 'CF_ACCESS_TEAM_DOMAIN');
  const audience = requireAccessBinding(env.CF_ACCESS_AUD, 'CF_ACCESS_AUD');
  const allowlistRaw = requireAccessBinding(env.ADMIN_ACTOR_ALLOWLIST, 'ADMIN_ACTOR_ALLOWLIST');
  const roleMapRaw = requireAccessBinding(env.ADMIN_ROLE_MAP, 'ADMIN_ROLE_MAP');
  const allowlist = parseAdminActorAllowlist(allowlistRaw);
  if (allowlist.size === 0) {
    throw new Error('pipeline misconfigured: ADMIN_ACTOR_ALLOWLIST parses to zero actors.');
  }
  const roles = parseAdminRoleMap(roleMapRaw);
  if (roles.size === 0) {
    throw new Error('pipeline misconfigured: ADMIN_ROLE_MAP parses to zero roles.');
  }
  return { teamDomain, audience, allowlist, roles };
}

/**
 * Remote JWKS resolvers memoized per team domain: `createRemoteJWKSet` keeps
 * its own fetch/rotation cache (the ~6-week Access key rotation), so one
 * instance per isolate is the correct lifetime — a key cache, not domain
 * state.
 */
const remoteJwksByDomain = new Map<string, JWTVerifyGetKey>();

function remoteAccessJwks(teamDomain: string): JWTVerifyGetKey {
  const cached = remoteJwksByDomain.get(teamDomain);
  if (cached !== undefined) return cached;
  const created = createRemoteJWKSet(
    new URL(`${accessIssuer(teamDomain)}/cdn-cgi/access/certs`)
  ) as JWTVerifyGetKey;
  remoteJwksByDomain.set(teamDomain, created);
  return created;
}

function parseDevPrivateJwk(env: Bindings): Record<string, unknown> {
  const raw = env.CF_ACCESS_DEV_PRIVATE_JWK;
  if (raw === undefined || raw === '') {
    throw new Error(
      'admin access: the dev signing key (CF_ACCESS_DEV_PRIVATE_JWK) is not configured. ' +
        'Dev/CI modes carry it via the env registry; production never does.'
    );
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The LOCAL verification JWKS: the public half of the committed dev signing key. */
function localDevJwks(env: Bindings): JWTVerifyGetKey {
  const publicJwk = { ...parseDevPrivateJwk(env) };
  delete publicJwk['d'];
  return createLocalJWKSet({ keys: [publicJwk] });
}

interface AccessVerification {
  readonly keySource: JWTVerifyGetKey;
  readonly algorithms: string[];
}

/**
 * Key source and accepted algorithms are resolved together so they cannot
 * drift apart: production verifies RS256 against Access's remote JWKS, every
 * other mode EdDSA against the committed dev key. Verification code is
 * identical in every mode — only this pair varies: never a bypass branch.
 */
function accessVerification(
  env: Bindings,
  envUtilities: EnvUtilities,
  teamDomain: string
): AccessVerification {
  return envUtilities.isProduction
    ? { keySource: remoteAccessJwks(teamDomain), algorithms: PRODUCTION_ALGORITHMS }
    : { keySource: localDevJwks(env), algorithms: DEV_ALGORITHMS };
}

/**
 * The route keys of this request's matched `admin`-classed registrations, read
 * off the registrations rather than the request so the key a role is checked
 * against IS the one the router matched (the HEAD-as-GET rewrite the posture
 * stage documents applies here identically). A class marker and the terminal
 * handler it guards register under one method and path, so they collapse to
 * one key.
 */
function adminRouteKeys(c: Context<AppEnv>): readonly string[] {
  const keys = new Set<string>();
  for (const route of matchedRoutes(c)) {
    if (isPipelineHandler(route.handler)) continue;
    if (readRouteClass(route.handler) === 'admin') keys.add(routeKey(route));
  }
  return [...keys];
}

/**
 * Whether every matched admin route admits the role — the one implementation
 * of that question, which the admin stage asks on every request and anything
 * else asking it calls rather than re-deriving. A second derivation would be a
 * second answer to the prototype hazard below, and the two would have to agree
 * to be correct.
 *
 * Prototype-safe lookup (`Object.hasOwn`), like the posture map's, so no key
 * can resolve to something `Object.prototype` carries; an undeclared key
 * admits nobody.
 */
export function routeAdmitsRole(
  routeRoles: AdminRouteRoleMap | undefined,
  keys: readonly string[],
  role: AdminRole
): boolean {
  if (routeRoles === undefined) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(routeRoles, key)) return false;
    return (routeRoles[key] ?? []).includes(role);
  });
}

/**
 * The verified Access identity, lowercased (email addresses are not
 * case-sensitive identities), or `null` for every refusal shape there is: no
 * header, a token that fails signature, expiry, issuer or audience, and one
 * carrying no non-empty `email` claim. They collapse to one answer on purpose —
 * the caller has a single 401 to give and nothing about which check failed may
 * reach it, or the response becomes an oracle.
 */
async function verifiedActorEmail(
  c: Context<AppEnv>,
  config: AdminAccessConfig,
  verification: AccessVerification
): Promise<string | null> {
  const token = c.req.header(CF_ACCESS_JWT_HEADER);
  if (token === undefined || token === '') return null;
  try {
    const { payload } = await jwtVerify(token, verification.keySource, {
      issuer: accessIssuer(config.teamDomain),
      audience: config.audience,
      algorithms: verification.algorithms,
    });
    const email = payload['email'];
    if (typeof email !== 'string' || email === '') return null;
    return email.toLowerCase();
    // eslint-disable-next-line catch-swallow/no-silent-catch -- the null above is the handling; the reason is deliberately not carried anywhere
  } catch {
    return null;
  }
}

/**
 * Pipeline stage: admin-actor resolution — the in-Worker belt behind the
 * Cloudflare Access edge wall (ARCHITECTURE §Admin plane). Runs ONLY when the
 * matched chain declares the `admin` route class; everything else passes
 * through untouched, so no product surface pays for it and a stray Access
 * header can never influence a product principal.
 *
 * Fail-closed: a missing, unparseable, expired, wrong-issuer, wrong-audience,
 * or non-allowlisted assertion answers 401 with the one indistinguishable
 * `{code}` body and ZERO effect — the handler never runs; so does an
 * allowlisted email the role map has no entry for, which is what keeps
 * "configured with nobody" refused. Only a fully verified assertion mints the
 * `admin-actor` principal the authorizer requires for `admin`-classed routes.
 *
 * The role check that follows is the plane's PRIMARY authorization control,
 * and it is keyed by route rather than by operation: most admin routes are
 * plain reads that never reach the operation engine, so a check living only
 * there would leave every one of them open to any authenticated role. It runs
 * after the identity is established and before any handler, and an undeclared
 * route is refused for every role — a new route fails closed instead of
 * defaulting open.
 */
export function pipelineAdmin(options?: PipelineAdminOptions): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    const adminKeys = adminRouteKeys(c);
    if (adminKeys.length === 0) return next();
    const envUtilities = readPipelineVariable(c, 'envUtils');
    if (envUtilities === undefined) {
      throw new Error('pipeline order violated: pipelineAdmin requires pipelineEnv first.');
    }
    const config = readAdminAccessConfig(c.env);
    const verification = accessVerification(c.env, envUtilities, config.teamDomain);
    const actor = await verifiedActorEmail(c, config, verification);
    if (actor === null || !config.allowlist.has(actor)) {
      return unauthorized(c);
    }
    const role = config.roles.get(actor);
    if (role === undefined) {
      return unauthorized(c);
    }
    bindRequestValue(c, 'principal', {
      kind: 'admin-actor',
      email: actor,
      audience: config.audience,
      role,
    });
    if (!routeAdmitsRole(options?.routeRoles, adminKeys, role)) {
      return roleRefused(c, adminKeys, role);
    }
    return next();
  });
}

function unauthorized(c: Context<AppEnv>): RefusalResponse {
  return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
}

/**
 * A refusal an operator must see: it is either a role probing a surface it was
 * never granted, or a route that shipped without a declaration. Nothing
 * durable records it — the audit trail holds acts, not the acts that did not
 * happen — so the capture is the only channel it survives on.
 */
function roleRefused(
  c: Context<AppEnv>,
  keys: readonly string[],
  role: AdminRole
): RefusalResponse {
  reportingLogger(c).captureError(
    new Error(`admin route refused role '${role}' on ${keys.join(', ')}`),
    FINGERPRINT_CODES.adminRoleRefused
  );
  return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
}

/** The bindings stage's logger, which every role refusal is reported through. */
function reportingLogger(c: Context<AppEnv>): Telemetry {
  const logger = readPipelineVariable(c, 'logger');
  if (logger === undefined) {
    throw new Error(
      'pipeline order violated: a role refusal is reported through the logger, so ' +
        'pipelineAdmin requires pipelineBindings first.'
    );
  }
  return logger;
}

interface DevAdminTokenParams {
  readonly email: string;
  /** Override to mint deliberately-wrong tokens in tests. */
  readonly audience?: string;
  readonly issuer?: string;
  /** Negative values mint an already-expired token (tests). */
  readonly expiresInSeconds?: number;
}

/**
 * Mints an Access-shaped JWT signed by the committed DEV key, for the
 * dev-admin mint route, the SPA's dev-auth fetch wrapper, and the e2e
 * suite — so the real jose verification path above is always in the loop. Impossible in
 * production by construction: the env registry carries no production value
 * for the signing key, so this throws there (and the mint route itself is
 * `dev-only`-classed, 404 in production).
 */
export async function mintDevAdminToken(
  env: Bindings,
  params: DevAdminTokenParams
): Promise<string> {
  const jwk = parseDevPrivateJwk(env);
  if (typeof jwk['d'] !== 'string') {
    throw new TypeError('admin access: dev signing key is not a private JWK (missing `d`).');
  }
  const key = await importJWK(jwk, 'EdDSA');
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = params.audience ?? env.CF_ACCESS_AUD;
  if (teamDomain === undefined || audience === undefined) {
    throw new Error(
      'admin access: minting needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD configured.'
    );
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lifetime = params.expiresInSeconds ?? DEV_TOKEN_LIFETIME_SECONDS;
  return (
    new SignJWT({ email: params.email })
      // The header carries the key's kid only when the key declares one — a
      // fabricated kid would fail local-JWKS selection against a kid-less key.
      .setProtectedHeader({
        alg: 'EdDSA',
        ...(typeof jwk['kid'] === 'string' ? { kid: jwk['kid'] } : {}),
      })
      .setSubject(params.email)
      .setIssuer(params.issuer ?? accessIssuer(teamDomain))
      .setAudience(audience)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + lifetime)
      .sign(key)
  );
}
