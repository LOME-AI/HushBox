import { ERROR_CODES, fromBase64, toBase64 } from '@hushbox/shared';
import { respondDomainError } from '../lib/context/index.js';
import { createErrorResponse, unavailableError } from '../lib/errors/index.js';
import { hashRateLimitId } from '../lib/rate-limit/index.js';
import { trustedCallerIpId } from '../lib/redis/index.js';
import { err, ok } from '../lib/result/index.js';
import type { Context } from 'hono';
import type { DomainError } from '../lib/errors/index.js';
import type { FailurePosture, RateLimitDecision } from '../lib/rate-limit/index.js';
import type { Result } from '../lib/result/index.js';
import type { AppEnv } from '../lib/context/index.js';

/**
 * The request-derived IDENTITIES a rate-limit posture is counted against, and
 * the refusal a decision earns. A posture declaration names an identity; the
 * pipeline stage resolves it here and hands the identifier to
 * `lib/rate-limit`, the repo's only implementation of the counting, which
 * admits exactly `maxAttempts` per window under any concurrency (doctrine:
 * Redis keys exist only as typed key-registry entries; the entries stay
 * slice-owned, and nothing here holds one).
 *
 * A resolver that reads the caller's address answers a REFUSAL for an address
 * it cannot derive, rather than a shared sentinel every caller behind the same
 * fault would key on. What the request then earns is the route's own failure
 * declaration, read by {@link rateLimitRefusal}: a route declaring `closed`
 * answers 503, a route declaring `open` is admitted uncounted and the admission
 * is reported. A `null` is neither — a caller the layer deliberately does not
 * count, whose request is admitted with no counter touched and nothing
 * reported.
 */

/**
 * Re-exported at the surface the pipeline stage's resolvers publish, so the
 * callers that key on a request keep reaching it here while the one
 * implementation sits where a slice's own domain can reach it too.
 */
export { hashRateLimitId } from '../lib/rate-limit/index.js';

/**
 * The refusal a decision earns, or `null` for admitted. Its own signature —
 * every other route answers a `DomainError` alone; this one answers a decision,
 * whose allowed case is not a response at all. The failure arm is the shared
 * refusal tail, so this path cannot drift from what the routes answer.
 *
 * `failure` is the route's own declaration and decides ONE arm: what a spend
 * that answered no decision earns. It is a parameter rather than a property of
 * the path that calls this, which is what lets a named route and a class
 * default answer the same input differently — and `null` on that arm is an
 * admission the route was not counted for, so a caller that can report a
 * bypass must treat a `null` here as one. The other two arms read the
 * decision: a caller past the cap earns the 429 under either value, and an
 * admitted one earns nothing.
 */
export function rateLimitRefusal(
  c: Context<AppEnv>,
  result: Result<RateLimitDecision, DomainError>,
  failure: FailurePosture
): Response | null {
  if (result.isErr()) {
    return failure === 'open' ? null : respondDomainError(c, limiterUnavailable(result.error));
  }
  if (result.value.allowed) return null;
  return c.json(
    createErrorResponse(ERROR_CODES.RATE_LIMITED, {
      retryAfterSeconds: result.value.retryAfterSeconds,
    }),
    429
  );
}

/**
 * The limiter's own unavailability, stamped so a caller can tell it from every
 * other 503 the Worker answers. This stage runs BEFORE the handler, so a
 * refusal it produces proves the request carrying it changed nothing; the
 * generic code cannot carry that promise, because a handler answers one after
 * work it may already have done — the card-processor adapter answers one after
 * an approved charge. A money guard on the web client reads the difference and
 * offers a re-submit only on this one, so the stamp is load-bearing rather than
 * cosmetic.
 *
 * Conditioned on the taxonomy code and on the error naming no code of its own:
 * an identifier rejected as over-long still answers its own `validation`
 * refusal, and an error carrying a wire code keeps it. The pairing the client
 * checks is structural, not a convention — `unavailable` maps to 503 and to no
 * other status, so this code cannot reach a caller at any other one.
 */
function limiterUnavailable(error: DomainError): DomainError {
  return error.code === 'unavailable' && error.wireCode === undefined
    ? { ...error, wireCode: ERROR_CODES.RATE_LIMIT_UNAVAILABLE }
    : error;
}

/**
 * A layer's identity for this request, or `null` when the layer deliberately
 * does not count this caller. The `null` arm is what a skip is: no counter is
 * touched, and no other layer learns anything from it.
 */
type CountedIdentity = Result<string | null, DomainError>;

type LayerIdentity = (c: Context<AppEnv>) => Promise<CountedIdentity>;

/**
 * The caller's IP identity, or the refusal a request the edge set no address on
 * earns. Every IP-keyed resolver here goes through it, so a production
 * request they would have to key on the shared sentinel cannot be admitted by
 * one and refused by another.
 *
 * Answering an error rather than the sentinel is what keeps the two
 * unspendable conditions on one footing: a window nothing can be keyed on
 * bounds nothing, exactly as a counter that cannot be reached bounds nothing,
 * and the route's failure declaration decides both alike. Neither is anything a
 * caller can present its way into — in production the edge sets that header on
 * every request that reaches us — which is what makes a route safe to declare
 * `open` without handing anyone a self-service bypass. Local modes resolve
 * through the fallback chain, so this arm is unreachable outside production.
 */
export async function ipIdentity(c: Context<AppEnv>): Promise<Result<string, DomainError>> {
  const ipHash = await trustedCallerIpId((name) => c.req.header(name), c.var.envUtils);
  return ipHash === null ? err(unavailableError('caller ip unresolved')) : ok(ipHash);
}

/**
 * The IP identity of a guest-reachable route, counting ONLY the callers whose
 * link credential the handler must resolve with a DB read: the bound stops a
 * flood of garbage credentials before any of them can spend an indexed lookup.
 *
 * IP-keyed rather than credential-keyed because a credential key is
 * attacker-chosen: rotating the header would mint a fresh window per request
 * and bound nothing. A full principal is resolved from its own cookie and
 * reaches no credential query, so it is not counted — an IP cap that counted it
 * would throttle every user behind one NAT on paths an authenticated client
 * reads constantly.
 */
export async function sessionlessIpIdentity(c: Context<AppEnv>): Promise<CountedIdentity> {
  if (c.var.principal.kind === 'full') return ok(null);
  const identity = await ipIdentity(c);
  return identity.map((ipHash): string | null => ipHash);
}

/**
 * Per-caller identity for the media member path: an authenticated
 * caller keys by userId; a shared-link caller keys by the composite
 * `ip:<sha256>:link:<sha256>` of the caller's IP identity and the canonicalized
 * credential (the pre-resolution stand-in for the registry's `link:<linkId>`
 * intent without a DB read at the edge); anyone else keys by that IP identity
 * alone (`ip:<sha256>`), which bounds unauthenticated probing ahead of the
 * handler's own 401. It never skips.
 *
 * Neither half is an identity by itself, which is why both are here.
 * `fromBase64` accepts every padding and alphabet variant of one link auth
 * token, so hashing the raw header let one leaked link occupy a fresh window per
 * mutation; canonicalizing through the decoder the authorization path itself
 * runs collapses those variants into one window. The credential is still
 * caller-presented and still rotatable after that, and the IP component is what
 * anchors it — but only because `trustedCallerIpId` reduces an IPv6 caller to its /64.
 * Keyed on the address as presented, the anchor would rotate as freely as the
 * credential it is anchoring. The cost is granularity: guests of one link
 * behind one /64 share a window; guests on different networks do not.
 */
export function callerIdentity(credentialHeader: string): LayerIdentity {
  return async (c) => {
    const callerId = await resolveCallerId(c, credentialHeader);
    return callerId.map((id): string | null => id);
  };
}

/**
 * Per-link identity keyed on the canonicalized credential alone — the link's auth
 * token, which is a stable global identifier for the link (one link, one token)
 * rather than a caller identity. It is what bounds the work ONE link can
 * buy across every network it is presented from; `callerIdentity`'s
 * composite key cannot, because a fresh network opens a fresh window there.
 *
 * Canonicalized for the same reason `callerIdentity` canonicalizes: hashing
 * the header as presented would give one link a fresh window per padding and
 * alphabet variant, bounding nothing at all.
 *
 * A full principal is skipped — its principal came from its own cookie and it
 * reaches no credential resolution, so counting it would let one link's traffic
 * throttle a signed-in member. An absent or undecodable credential is skipped
 * rather than counted: it names no link, and the guest resolution refuses it
 * before reaching any store, so there is no per-link work behind it to bound.
 * Those callers are bounded per network by the IP layer that fronts this one.
 * The skipped set is a subset of what resolution refuses before the store, not
 * all of it: a decodable credential of the wrong length is refused there too,
 * yet is counted here under its canonical form.
 */
export function linkCredentialIdentity(credentialHeader: string): LayerIdentity {
  return async (c) => {
    if (c.var.principal.kind === 'full') return ok(null);
    const credential = c.req.header(credentialHeader);
    const canonical = credential === undefined ? null : canonicalCredential(credential);
    if (canonical === null) return ok(null);
    return ok(await hashRateLimitId(canonical));
  };
}

/**
 * The credential's canonical form — the base64 of its decoded bytes, so every
 * encoding of one link auth token maps to one identifier. `null` when the
 * credential decodes to nothing: it names no link, so those callers key by IP
 * alongside every other nameless one. A decodable credential that can still
 * resolve to no link (a wrong length, an unknown token) keeps its canonical form.
 */
function canonicalCredential(credential: string): string | null {
  try {
    const decoded = fromBase64(credential);
    return decoded.length === 0 ? null : toBase64(decoded);
    // eslint-disable-next-line catch-swallow/no-silent-catch -- an undecodable credential is expected external input, and `null` is this function's documented answer for one that decodes to nothing
  } catch {
    return null;
  }
}

async function resolveCallerId(
  c: Context<AppEnv>,
  credentialHeader: string
): Promise<Result<string, DomainError>> {
  const principal = c.var.principal;
  if (principal.kind === 'full') return ok(principal.claims.userId);
  const identity = await ipIdentity(c);
  if (identity.isErr()) return identity;
  const ipId = `ip:${identity.value}`;
  const credential = c.req.header(credentialHeader);
  const canonical = credential === undefined ? null : canonicalCredential(credential);
  if (canonical === null) return ok(ipId);
  return ok(`${ipId}:link:${await hashRateLimitId(canonical)}`);
}
