import { sealData } from 'iron-session';
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, preferences, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { UPGRADE_TICKET_PARAM, createEnvUtilities } from '@hushbox/shared';
import { ROUTE_CACHE_POLICIES } from '../composition/route-cache-policy.js';
import { SESSION_COOKIE_NAME } from '../lib/context/index.js';
import { cacheDirectives } from '../lib/cache-policy/index.js';
import { callerIpId } from '../lib/redis/index.js';
import { LINK_CREDENTIAL_HEADER } from '../slices/conversations/domain/index.js';
import type { Database } from '@hushbox/db';
import type { RouteKey } from '../composition/app-route-key.js';

/**
 * # The proof a storable declaration rests on
 *
 * A route declared storable in `ROUTE_CACHE_POLICIES` may have its response
 * replayed by a cache the caller does not own, so the claim licensing that
 * declaration is that every caller receives the same bytes. Route class is not
 * evidence of it — `GET /chat/trial/remaining` is `public` and derives its body
 * from the caller's address — and no static rule can establish it either, so
 * each declaration is proven here instead, and the arch rule
 * `cacheable-routes-prove-caller-invariance` requires that the proof exists.
 *
 * The comparison is over BYTES rather than over parsed values: a shared cache
 * replays a body, not a structure, so two responses that deep-equal after
 * parsing but serialize differently are two different cache entries.
 *
 * One implementation rather than a hand-rolled one per route, because what
 * makes two callers different is the whole substance of the proof: a variation
 * a copy omitted would be a caller input that copy silently never tested.
 *
 * The same call also observes the `Cache-Tag` a storable policy renders
 * reaching the response. Nothing purges by tag — a deploy starts the cache
 * cold on its own (`apps/api/wrangler.toml`) — so what this holds is the
 * narrower claim that the tag is on the wire if a selective purge is ever
 * wanted. Observing it here rather than in each route's own test is what
 * covers a storable declaration written later: the proof is already required
 * of it, so the tag comes with it.
 */

/** One caller's request, ready for the app under test to answer. */
export interface CallerRequest {
  readonly path: string;
  readonly headers: Record<string, string>;
}

interface CallerInvarianceProof {
  /** The concrete path under test, with no query string of its own. */
  readonly path: string;
  /** The `IRON_SESSION_SECRET` the app under test was built with. */
  readonly sessionSecret: string;
  /** The `DATABASE_URL` the app under test was built with. */
  readonly databaseUrl: string;
  /**
   * The per-user rows THIS route could key its answer on, written against the
   * identified caller's own id. Required rather than optional so that adding a
   * proof forces the question to be answered — an empty body is the answer
   * "this route's slice owns no per-user state", visible in review, where an
   * omitted hook would be silence.
   */
  readonly seedIdentifiedState: (userId: string) => Promise<void>;
  readonly respondTo: (request: CallerRequest) => Promise<Response>;
}

/**
 * A fresh address per caller, per call. The per-IP windows these routes declare
 * are shared by every caller presenting the same address, so a fixed pair would
 * eventually refuse its own later runs and every other proof's.
 */
function freshAddress(): string {
  return `203.0.113.9-${crypto.randomUUID()}`;
}

/**
 * One value of its own per header the address-resolution chain reads, so a
 * chain that switched which header it trusts still sees two different callers.
 * Whether that holds is not left to this sentence:
 * {@link expectDistinctAddressIdentities} resolves both callers through the
 * chain and fails when they collapse onto one identity.
 */
function addressHeaders(): Record<string, string> {
  return {
    'cf-connecting-ip': freshAddress(),
    'x-forwarded-for': freshAddress(),
    'x-real-ip': freshAddress(),
  };
}

/**
 * The mode the chain is read under. Every proof drives its app in development,
 * where the two fallback headers are live, so resolving under anything else
 * would judge the sample against a chain the responses never went through.
 */
const CALLER_CHAIN_ENV = createEnvUtilities({ NODE_ENV: 'development' });

/**
 * The two callers really are two addresses to the chain every per-IP window in
 * the Worker keys on. A sample that stopped carrying an address header would
 * leave both callers on the shared loopback sentinel — one identity, and every
 * address arm of this proof silently testing nothing — so it is asserted here
 * rather than described.
 *
 * The limit worth knowing: this establishes that the sample reaches the chain,
 * not that it covers it. A chain that grew a fourth header while still reading
 * the first would resolve two identities here and leave the new one untested.
 */
async function expectDistinctAddressIdentities(
  anonymous: Record<string, string>,
  identified: Record<string, string>
): Promise<void> {
  const identityOf = async (headers: Record<string, string>): Promise<string> =>
    callerIpId((name) => headers[name], CALLER_CHAIN_ENV);
  expect(
    await identityOf(anonymous),
    'the two callers resolve to one address identity, so no address arm of this proof varies'
  ).not.toBe(await identityOf(identified));
}

/**
 * Non-credential headers, differing between the callers. This is the quadrant a
 * query string does not cover and the platform does not either: a query IS part
 * of the cache key, an arbitrary request header is only part of it when `Vary`
 * says so, and the `Vary` written on this path is the CORS stage's
 * (`apps/api/src/middleware/cors.ts`), naming `Origin` — the header deciding
 * which cross-origin grant lands, never one a handler filters on. So a
 * header-driven filter would be replayed to callers who sent a different one.
 * `X-HushBox-Platform` is the live instance rather than a hypothetical:
 * `slices/updates/routes.ts` already selects a per-platform checksum from it on
 * `GET /updates/current`.
 *
 * The set is necessarily a sample, because request headers are unbounded:
 * personalization keyed on a header outside it is NOT caught here, and a route
 * that grows one needs its header added to this set.
 *
 * `Origin` and `X-App-Version` are deliberately absent: the CORS and
 * version-check stages answer them, so varying them tests those stages rather
 * than the handler's body.
 */
const ANONYMOUS_HEADERS: Record<string, string> = {
  'accept-language': 'en-US,en;q=0.9',
  'x-hushbox-platform': 'web',
  'user-agent': 'hushbox-caller-invariance/anonymous',
};

const IDENTIFIED_HEADERS: Record<string, string> = {
  'accept-language': 'fr-CA,fr;q=0.9',
  'x-hushbox-platform': 'android',
  'user-agent': 'hushbox-caller-invariance/identified',
};

/**
 * The identified caller's session cookie. Sealed rather than fabricated because
 * the pipeline derives a FULL principal from it without touching the database —
 * a caller presenting an unreadable cookie degrades to the anonymous principal,
 * which would make a personalized response identical for both callers and the
 * proof vacuous.
 *
 * `userId` names a row that exists, for the same reason: a minted id belongs to
 * nobody, so every read keyed on it comes back empty and matches the anonymous
 * caller's default answer byte for byte.
 */
async function sealCallerSession(sessionSecret: string, userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: crypto.randomUUID(),
      createdAt: Date.now(),
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: sessionSecret }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

/** The caller presenting no credential of any kind. */
function anonymousHeaders(): Record<string, string> {
  return { ...addressHeaders(), ...ANONYMOUS_HEADERS };
}

/**
 * The identified caller: the address and non-credential arms, plus the
 * credentials it presents — a live session, a link credential, a trial token.
 * Those three are a sample rather than the whole credential surface, so a
 * route reading a credential kind outside them reads an input absent for BOTH
 * callers, exactly as an unlisted header is.
 *
 * The link credential is sent under the constant the conversation read
 * publishes, so renaming that header moves this caller with it. `x-trial-token`
 * is a literal because the trial routes spell it out too and export no
 * constant to bind to — rename it there and this arm goes on sending a name
 * nothing reads, absent for both callers and signalled by nothing, since the
 * canary this file's test generates asks only that the two callers differ.
 */
function identifiedHeaders(sessionCookie: string): Record<string, string> {
  return {
    ...addressHeaders(),
    ...IDENTIFIED_HEADERS,
    [LINK_CREDENTIAL_HEADER]: crypto.randomUUID(),
    'x-trial-token': crypto.randomUUID(),
    cookie: sessionCookie,
  };
}

/**
 * Every header name the two callers are sent, read off the builders that send
 * them rather than listed beside them. The helper's own test generates one
 * canary per name, so a header either caller starts carrying acquires its
 * canary with nothing written, and a header carried identically by both fails
 * the canary it generates.
 *
 * The other direction is not guarded: a header the builders stop sending stops
 * generating a canary, so this holds arms that drift IN to a proof, never the
 * sample against shrinking.
 */
export const CALLER_HEADER_ARMS: readonly string[] = Object.keys({
  ...anonymousHeaders(),
  ...identifiedHeaders(''),
});

/**
 * The query the identified caller appends. A storable route that grew a filter
 * would answer it differently — the query string is part of the platform's
 * cache key, so a varying query is no leak in itself, but a route that READS
 * one has become a route whose body depends on caller input, and this is the
 * only guard that a declared-storable route has not quietly become that.
 *
 * `trialToken` and the upgrade ticket are the credential half of it: both
 * WebSocket upgrade paths take a credential from the query string, because a
 * browser opening a socket can set no header. A query carrying neither leaves
 * those two caller inputs absent for BOTH callers, which is the shape a route
 * reads and this proof passes anyway. The ticket parameter is named through the
 * constant the upgrade reads, so renaming it moves this caller with it.
 *
 * Like the header set this is a sample of an unbounded space: a route reading
 * a parameter outside it is not caught here, and one that grows such a
 * parameter needs it added.
 */
const CALLER_QUERY = [
  'locale=fr-CA',
  'limit=1',
  'platform=android',
  `trialToken=${crypto.randomUUID()}`,
  `${UPGRADE_TICKET_PARAM}=${crypto.randomUUID()}`,
].join('&');

/**
 * Every parameter name {@link CALLER_QUERY} carries, read off that query itself
 * so a parameter added there arrives here with nothing written beside it.
 */
export const CALLER_QUERY_ARMS: readonly string[] = [...new URLSearchParams(CALLER_QUERY).keys()];

/** Opaque bytes for the account columns no route under proof ever reads. */
const OPAQUE_BYTES = new Uint8Array([1, 2, 3]);

/**
 * The identified caller as a real account carrying stored state: the `users`
 * row every per-user foreign key needs to exist, and a `preferences` row on it —
 * the general per-user settings table, and so the one a filter grown on a
 * public read would most plausibly consult.
 *
 * What this footprint does NOT cover is per-user state on a table nothing
 * seeds. That is what {@link CallerInvarianceProof.seedIdentifiedState} is for,
 * and a route personalized from a table neither writes is not caught here.
 */
async function persistIdentifiedCaller(db: Database): Promise<string> {
  const username = `caller-inv-${crypto.randomUUID().slice(0, 8)}`;
  const inserted = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@caller-invariance.test`,
        username,
        opaqueRegistration: OPAQUE_BYTES,
        publicKey: OPAQUE_BYTES,
        passwordWrappedPrivateKey: OPAQUE_BYTES,
        recoveryWrappedPrivateKey: OPAQUE_BYTES,
        recoveryPublicKey: OPAQUE_BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = inserted[0]?.id;
  if (userId === undefined) {
    throw new Error('caller-invariance: the identified caller could not be persisted');
  }
  await db.insert(preferences).values({ userId });
  return userId;
}

/**
 * The purge tag the route's declaration renders to, or `undefined` when the
 * declaration is the refusal and there is no storable entry to tag.
 *
 * Rendered through {@link cacheDirectives} rather than read off the map entry,
 * because the tag a cache holds is the one the stage renders: reading the
 * declared field would agree with itself while a rendering change made the
 * header wrong.
 */
function declaredCacheTag(route: RouteKey): string | undefined {
  return cacheDirectives(ROUTE_CACHE_POLICIES[route]).cacheTag;
}

/**
 * Proves the route named answers two deliberately different callers with
 * identical bytes. `route` is the key the declaration is written under, and is
 * what the arch rule reads to know which declaration this proof discharges.
 */
export async function proveCallerInvariance(
  route: RouteKey,
  proof: CallerInvarianceProof
): Promise<void> {
  const db = createDb(proof.databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  let userId: string | undefined;
  try {
    userId = await persistIdentifiedCaller(db);
    await proof.seedIdentifiedState(userId);

    const anonymousRequest = anonymousHeaders();
    const identifiedRequest = identifiedHeaders(
      await sealCallerSession(proof.sessionSecret, userId)
    );
    await expectDistinctAddressIdentities(anonymousRequest, identifiedRequest);

    const anonymous = await proof.respondTo({ path: proof.path, headers: anonymousRequest });
    const identified = await proof.respondTo({
      path: `${proof.path}?${CALLER_QUERY}`,
      headers: identifiedRequest,
    });

    expect(
      [anonymous.status, identified.status],
      `${route} answered a caller with an error`
    ).toEqual([200, 200]);
    const declaredTag = declaredCacheTag(route);
    if (declaredTag !== undefined) {
      expect(
        [anonymous.headers.get('Cache-Tag'), identified.headers.get('Cache-Tag')],
        `${route} answered a caller without the Cache-Tag its declaration renders`
      ).toEqual([declaredTag, declaredTag]);
    }
    const first = new Uint8Array(await anonymous.arrayBuffer());
    const second = new Uint8Array(await identified.arrayBuffer());
    expect(second.byteLength, `${route} answers callers with different body lengths`).toBe(
      first.byteLength
    );
    expect(second, `${route} answers two callers with different bytes`).toStrictEqual(first);
  } finally {
    // Every row the caller carries hangs off this one by a cascading key.
    if (userId !== undefined) await db.delete(users).where(eq(users.id, userId));
    await db.$client.end();
  }
}
