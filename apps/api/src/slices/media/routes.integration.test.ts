import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { Redis } from '@upstash/redis';
import { ERROR_CODES, fromBase64, toStandardBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { callerIpIdForAddress } from '../../lib/redis/index.js';
import { hashRateLimitId } from '../../middleware/rate-limit.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { mediaObjectKey } from './ports/index.js';
import { LINK_CREDENTIAL_HEADER } from './domain/index.js';
import { MEDIA_ROUTE_POSTURES } from './rate-limit-posture.js';
import { createScratchBucket, unwrap } from './adapters/test-fixtures.js';
import { MEDIA_RATE_LIMITS, reserveShareRemint } from './domain/index.js';
import { createMediaManifest } from './index.js';
import { mintLinkCredential } from '../../test-support/link-credential.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { ScratchBucket } from './adapters/test-fixtures.js';
import type { RateLimitDefinition } from '../../lib/rate-limit/index.js';
import type { MediaRouteDeps } from './index.js';
import type { MediaTarget, MessageShare, PresignReaders } from './ports/index.js';
import type { LinkCredential } from '../../test-support/link-credential.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for media route tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const grantSchema = z.object({ downloadUrl: z.string(), expiresAt: z.string() });
const errorBodySchema = z.object({ code: z.string() });

const BYTES = new Uint8Array([13, 14, 15]);
const ITEM_ID = crypto.randomUUID();
const CONVERSATION_ID = crypto.randomUUID();
const EPOCH_ID = crypto.randomUUID();
const LINK_ID = crypto.randomUUID();
const STORAGE_KEY = mediaObjectKey({
  conversationId: CONVERSATION_ID,
  messageId: crypto.randomUUID(),
  objectId: crypto.randomUUID(),
});

const MEDIA_TARGET: MediaTarget = {
  contentItemId: ITEM_ID,
  conversationId: CONVERSATION_ID,
  epochId: EPOCH_ID,
  contentType: 'image',
  storageKey: STORAGE_KEY,
};

interface ReaderConfig {
  readonly target?: MediaTarget | null;
  readonly isActiveMember?: boolean;
  readonly isEpochMember?: boolean;
  readonly share?: MessageShare | null;
}

function fakeReaders(config: ReaderConfig): PresignReaders {
  return {
    contentItems: { findMediaTarget: () => okAsync(config.target ?? MEDIA_TARGET) },
    membership: {
      isActiveMember: () => okAsync(config.isActiveMember ?? false),
      isEpochMember: () => okAsync(config.isEpochMember ?? false),
    },
    shares: { findShare: () => okAsync(config.share ?? null) },
  };
}

async function sessionCookie(overrides: { pending2FA?: boolean } = {}): Promise<string> {
  const sealed = await sealData(
    {
      userId: crypto.randomUUID(),
      sessionId: `session-${crypto.randomUUID()}`,
      createdAt: Date.now() - 1000,
      pending2FA: overrides.pending2FA ?? false,
      pending2FAExpiresAt: overrides.pending2FA === true ? Date.now() + 60_000 : 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

describe('media presign routes', () => {
  let scratch: ScratchBucket;
  const keysToClean: string[] = [];

  beforeAll(async () => {
    scratch = await createScratchBucket();
    await unwrap(
      scratch.storage.put(STORAGE_KEY, BYTES, { contentType: 'application/octet-stream' })
    );
  });

  afterAll(async () => {
    await scratch.destroy();
    if (keysToClean.length > 0) await redis.del(...keysToClean);
  });

  function createApp(readers: ReaderConfig, overrides: Partial<MediaRouteDeps> = {}): Hono<AppEnv> {
    const manifest = createMediaManifest({
      readers: () => fakeReaders(readers),
      storage: () => scratch.storage,
      linkResolution: () => ({ resolveLinkCredential: () => okAsync(null) }),
      ...overrides,
    });
    const app = applyPipeline(new Hono<AppEnv>(), {
      rateLimit: {
        postures: MEDIA_ROUTE_POSTURES,
        linkCredentialHeader: LINK_CREDENTIAL_HEADER,
      },
    });
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  function memberPath(contentItemId: string = ITEM_ID): string {
    return `/media/${contentItemId}/download-url`;
  }

  function sharePath(shareId: string, contentItemId: string = ITEM_ID): string {
    return `/media/shared/${shareId}/${contentItemId}/download-url`;
  }

  it('a member holding the epoch row downloads the bytes through the minted URL', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(200);
    const body = grantSchema.parse(await response.json());
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    const fetched = await fetch(body.downloadUrl);
    expect([...new Uint8Array(await fetched.arrayBuffer())]).toEqual([...BYTES]);
  });

  it('a conversation member without the epoch row is denied blind', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: false });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('a non-member session is denied blind', async () => {
    const app = createApp({ isActiveMember: false });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(404);
  });

  it('a caller with neither a session nor a link credential is unauthenticated', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(memberPath(), {}, testEnv);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('a pending-2fa session is not admitted to the member path', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie({ pending2FA: true }) } },
      testEnv
    );

    expect(response.status).toBe(401);
  });

  it('a link guest holding the epoch row downloads through its credential', async () => {
    const app = createApp(
      { isActiveMember: true, isEpochMember: true },
      {
        linkResolution: () => ({
          resolveLinkCredential: () =>
            okAsync({ linkId: LINK_ID, conversationId: CONVERSATION_ID }),
        }),
      }
    );

    const response = await app.request(
      memberPath(),
      { headers: { [LINK_CREDENTIAL_HEADER]: mintLinkCredential().token } },
      testEnv
    );

    expect(response.status).toBe(200);
  });

  it('a link credential that resolves to nothing is unauthenticated', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath(),
      { headers: { [LINK_CREDENTIAL_HEADER]: mintLinkCredential().token } },
      testEnv
    );

    expect(response.status).toBe(401);
  });

  it('an unanswerable link store fails closed', async () => {
    const app = createApp(
      { isActiveMember: true, isEpochMember: true },
      {
        linkResolution: () => ({
          resolveLinkCredential: () => errAsync(unavailableError('store down')),
        }),
      }
    );

    const response = await app.request(
      memberPath(),
      { headers: { [LINK_CREDENTIAL_HEADER]: mintLinkCredential().token } },
      testEnv
    );

    expect(response.status).toBe(503);
  });

  /**
   * A per-case caller address, so each case starts on its own empty window and
   * cannot be answered by a neighbour's exhausted one. Not an IPv6 literal, so
   * the identity hashes it verbatim rather than collapsing it to a /64.
   */
  function caseIp(label: string): string {
    return `media-presign-${label}-${crypto.randomUUID()}`;
  }

  /**
   * Counts the `shared_links` resolutions the request causes. The credential is
   * well-formed on purpose: a malformed one short-circuits to "no guest" without
   * ever reaching the store, so it could not tell an unreached query apart from
   * a refused one.
   */
  function countingGuestApp(): { app: Hono<AppEnv>; resolutions: () => number } {
    let resolutions = 0;
    const app = createApp(
      { isActiveMember: true, isEpochMember: true },
      {
        linkResolution: () => ({
          resolveLinkCredential: () => {
            resolutions += 1;
            return okAsync(null);
          },
        }),
      }
    );
    return { app, resolutions: () => resolutions };
  }

  function guestRequest(ip: string): RequestInit {
    return {
      headers: {
        [LINK_CREDENTIAL_HEADER]: mintLinkCredential().token,
        'cf-connecting-ip': ip,
      },
    };
  }

  async function seedGuestIpWindowAtCap(ip: string): Promise<void> {
    const definition = MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit;
    const key = rateLimitKey(definition, await callerIpIdForAddress(ip))._unsafeUnwrap();
    keysToClean.push(key);
    const { maxAttempts, windowSeconds } = definition;
    await redis.set(key, maxAttempts, { ex: windowSeconds });
  }

  it('resolves a sessionless credential against the link store while the IP window is open', async () => {
    const { app, resolutions } = countingGuestApp();

    const response = await app.request(memberPath(), guestRequest(caseIp('open')), testEnv);

    expect(response.status).toBe(401);
    expect(resolutions()).toBe(1);
  });

  it('never reaches the link store once the sessionless IP window is at its cap', async () => {
    const { app, resolutions } = countingGuestApp();
    const ip = caseIp('capped');
    await seedGuestIpWindowAtCap(ip);

    const response = await app.request(memberPath(), guestRequest(ip), testEnv);

    expect(response.status).toBe(429);
    expect(resolutions()).toBe(0);
  });

  it('leaves a full session untouched by the sessionless IP window', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });
    const ip = caseIp('session');
    await seedGuestIpWindowAtCap(ip);

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie(), 'cf-connecting-ip': ip } },
      testEnv
    );

    expect(response.status).toBe(200);
  });

  /** A guest app whose credential resolves to one nominated link. */
  function linkGuestApp(linkId: string, overrides: Partial<MediaRouteDeps> = {}): Hono<AppEnv> {
    return createApp(
      { isActiveMember: true, isEpochMember: true },
      {
        linkResolution: () => ({
          resolveLinkCredential: () => okAsync({ linkId, conversationId: CONVERSATION_ID }),
        }),
        ...overrides,
      }
    );
  }

  /**
   * Seeds one of the two per-link windows `count` mints in, so a boundary case
   * costs two requests instead of the cap's worth. The key carries a fresh TTL,
   * so the window is open.
   */
  async function seedLinkWindow(
    definition: RateLimitDefinition,
    id: string,
    count: number
  ): Promise<void> {
    const key = rateLimitKey(definition, id)._unsafeUnwrap();
    keysToClean.push(key);
    await redis.set(key, count, { ex: definition.windowSeconds });
  }

  /** Two encodings of one link auth token: the canonical form, and a standard-alphabet one. */
  function credentialVariants(credential: LinkCredential): {
    canonical: string;
    otherEncoding: string;
  } {
    return {
      canonical: credential.token,
      otherEncoding: toStandardBase64(fromBase64(credential.token)),
    };
  }

  function guestRequestWithCredential(ip: string, credential: string): RequestInit {
    return { headers: { [LINK_CREDENTIAL_HEADER]: credential, 'cf-connecting-ip': ip } };
  }

  /**
   * The counter key a limiter will actually touch. Built through the
   * primitive's own resolver rather than `buildKey`, because the primitive
   * keys the identifier and a test re-deriving that digest would be a second
   * copy of it.
   */
  function keyFor(definition: RateLimitDefinition, id: string): string {
    return rateLimitKey(definition, id)._unsafeUnwrap();
  }

  /**
   * A link guest's per-caller window key. One derivation, shared by the case
   * that asserts the counter advances and the case that asserts it does not:
   * a negative assertion on a key nothing writes would pass whatever the
   * identity is, so it measures the limiter only while the positive case pins
   * the same derivation to the key the middleware really touches.
   */
  function linkGuestCallerKey(ipId: string, credentialHash: string): string {
    return keyFor(
      MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit,
      `ip:${ipId}:link:${credentialHash}`
    );
  }

  it('counts an admitted link guest against the per-caller window of its network and credential', async () => {
    const { canonical } = credentialVariants(mintLinkCredential());
    const credentialHash = await hashRateLimitId(canonical);
    const ip = caseIp('caller-window');
    const ipId = await callerIpIdForAddress(ip);
    const callerKey = linkGuestCallerKey(ipId, credentialHash);
    keysToClean.push(
      callerKey,
      rateLimitKey(MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit, ipId)._unsafeUnwrap(),
      rateLimitKey(
        MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit,
        credentialHash
      )._unsafeUnwrap()
    );

    const admitted = await linkGuestApp(crypto.randomUUID()).request(
      memberPath(),
      guestRequestWithCredential(ip, canonical),
      testEnv
    );

    expect(admitted.status).toBe(200);
    expect(await redis.get<number>(callerKey)).toBe(1);
  });

  it('leaves the sibling windows untouched when the per-link lookup window refuses', async () => {
    const { canonical } = credentialVariants(mintLinkCredential());
    const lookup = MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit;
    const credentialHash = await hashRateLimitId(canonical);
    await seedLinkWindow(lookup, credentialHash, lookup.maxAttempts);
    const ip = caseIp('all-or-nothing');
    const ipId = await callerIpIdForAddress(ip);
    const guestIpKey = keyFor(MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit, ipId);
    const callerKey = linkGuestCallerKey(ipId, credentialHash);
    keysToClean.push(guestIpKey, callerKey);

    const refused = await linkGuestApp(crypto.randomUUID()).request(
      memberPath(),
      guestRequestWithCredential(ip, canonical),
      testEnv
    );

    // All-or-nothing: an attacker holding one link must not be able to spend
    // the windows of every guest sharing its network by making requests that
    // are refused before they reach the store.
    expect(refused.status).toBe(429);
    expect(await Promise.all([redis.get(guestIpKey), redis.get(callerKey)])).toEqual([null, null]);
    expect(await redis.get<number>(rateLimitKey(lookup, credentialHash)._unsafeUnwrap())).toBe(
      lookup.maxAttempts + 1
    );
  });

  it('counts a link guest mint against the mint window of its link', async () => {
    const linkId = crypto.randomUUID();
    const key = rateLimitKey(
      MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit,
      linkId
    )._unsafeUnwrap();
    keysToClean.push(key);

    const response = await linkGuestApp(linkId).request(
      memberPath(),
      guestRequest(caseIp('link-counted')),
      testEnv
    );

    expect(response.status).toBe(200);
    expect(await redis.get(key)).toBe(1);
  });

  it('admits the mint that reaches the per-link cap and refuses the next one', async () => {
    const linkId = crypto.randomUUID();
    const mint = MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit;
    await seedLinkWindow(mint, linkId, mint.maxAttempts - 1);
    const app = linkGuestApp(linkId);
    const ip = caseIp('link-mint-boundary');

    const atCap = await app.request(memberPath(), guestRequest(ip), testEnv);
    const pastCap = await app.request(memberPath(), guestRequest(ip), testEnv);

    expect(atCap.status).toBe(200);
    expect(pastCap.status).toBe(429);
    expect(errorBodySchema.parse(await pastCap.json()).code).toBe(ERROR_CODES.RATE_LIMITED);
  });

  it('resolves the credential before refusing on the mint window', async () => {
    let resolutions = 0;
    const linkId = crypto.randomUUID();
    const mint = MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit;
    await seedLinkWindow(mint, linkId, mint.maxAttempts);
    const app = createApp(
      { isActiveMember: true, isEpochMember: true },
      {
        linkResolution: () => ({
          resolveLinkCredential: () => {
            resolutions += 1;
            return okAsync({ linkId, conversationId: CONVERSATION_ID });
          },
        }),
      }
    );

    const response = await app.request(
      memberPath(),
      guestRequest(caseIp('link-mint-resolved')),
      testEnv
    );

    expect(response.status).toBe(429);
    expect(resolutions).toBe(1);
  });

  it('never reaches the presign authorization once the mint window is at its cap', async () => {
    let targets = 0;
    const linkId = crypto.randomUUID();
    const mint = MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit;
    await seedLinkWindow(mint, linkId, mint.maxAttempts);
    const app = linkGuestApp(linkId, {
      readers: () => ({
        ...fakeReaders({ isActiveMember: true, isEpochMember: true }),
        contentItems: {
          findMediaTarget: () => {
            targets += 1;
            return okAsync(MEDIA_TARGET);
          },
        },
      }),
    });

    await app.request(memberPath(), guestRequest(caseIp('link-capped-authz')), testEnv);

    expect(targets).toBe(0);
  });

  it('leaves a guest of another link unaffected by an exhausted mint window', async () => {
    const mint = MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit;
    await seedLinkWindow(mint, crypto.randomUUID(), mint.maxAttempts);
    const other = crypto.randomUUID();
    keysToClean.push(rateLimitKey(mint, other)._unsafeUnwrap());

    const response = await linkGuestApp(other).request(
      memberPath(),
      guestRequest(caseIp('link-other')),
      testEnv
    );

    expect(response.status).toBe(200);
  });

  it('admits the lookup that reaches the per-link cap and refuses the next one', async () => {
    const { canonical } = credentialVariants(mintLinkCredential());
    const lookup = MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit;
    const linkId = crypto.randomUUID();
    keysToClean.push(
      rateLimitKey(MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit, linkId)._unsafeUnwrap()
    );
    await seedLinkWindow(lookup, await hashRateLimitId(canonical), lookup.maxAttempts - 1);
    const app = linkGuestApp(linkId);
    const ip = caseIp('link-lookup-boundary');

    const atCap = await app.request(
      memberPath(),
      guestRequestWithCredential(ip, canonical),
      testEnv
    );
    const pastCap = await app.request(
      memberPath(),
      guestRequestWithCredential(ip, canonical),
      testEnv
    );

    expect(atCap.status).toBe(200);
    expect(pastCap.status).toBe(429);
  });

  it('never reaches the link store once the lookup window of that link is at its cap', async () => {
    let resolutions = 0;
    const { canonical } = credentialVariants(mintLinkCredential());
    const lookup = MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit;
    await seedLinkWindow(lookup, await hashRateLimitId(canonical), lookup.maxAttempts);
    const app = createApp(
      { isActiveMember: true, isEpochMember: true },
      {
        linkResolution: () => ({
          resolveLinkCredential: () => {
            resolutions += 1;
            return okAsync({ linkId: LINK_ID, conversationId: CONVERSATION_ID });
          },
        }),
      }
    );

    const response = await app.request(
      memberPath(),
      guestRequestWithCredential(caseIp('link-lookup-capped'), canonical),
      testEnv
    );

    expect(response.status).toBe(429);
    expect(resolutions).toBe(0);
  });

  it('keys the lookup window on the canonical credential, not the header as presented', async () => {
    const credential = mintLinkCredential();
    const { canonical, otherEncoding } = credentialVariants(credential);
    const lookup = MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit;
    await seedLinkWindow(lookup, await hashRateLimitId(canonical), lookup.maxAttempts);

    const response = await linkGuestApp(crypto.randomUUID()).request(
      memberPath(),
      guestRequestWithCredential(caseIp('link-lookup-encoding'), otherEncoding),
      testEnv
    );

    expect(otherEncoding).not.toBe(canonical);
    expect(fromBase64(otherEncoding)).toEqual(fromBase64(credential.token));
    expect(response.status).toBe(429);
  });

  it('leaves a full session untouched by an exhausted link lookup window', async () => {
    const { canonical } = credentialVariants(mintLinkCredential());
    const lookup = MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit;
    await seedLinkWindow(lookup, await hashRateLimitId(canonical), lookup.maxAttempts);
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie(), [LINK_CREDENTIAL_HEADER]: canonical } },
      testEnv
    );

    expect(response.status).toBe(200);
  });

  it('a non-media content item answers a validation error to an authorized member', async () => {
    const app = createApp({
      isActiveMember: true,
      isEpochMember: true,
      target: { ...MEDIA_TARGET, contentType: 'text', storageKey: null },
    });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('a valid shareId downloads that shared message media with no authentication', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
    });

    const response = await app.request(sharePath(crypto.randomUUID()), {}, testEnv);

    expect(response.status).toBe(200);
    const body = grantSchema.parse(await response.json());
    const fetched = await fetch(body.downloadUrl);
    expect(fetched.ok).toBe(true);
  });

  it('a shareId is denied for a content item outside its shared message', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [crypto.randomUUID()] },
    });

    const response = await app.request(sharePath(crypto.randomUUID()), {}, testEnv);

    expect(response.status).toBe(404);
  });

  it('a revoked share is denied blind', async () => {
    const app = createApp({
      share: { revokedAt: new Date(), expiresAt: null, contentItemIds: [ITEM_ID] },
    });

    const response = await app.request(sharePath(crypto.randomUUID()), {}, testEnv);

    expect(response.status).toBe(404);
  });

  it('an expired share is denied blind', async () => {
    const app = createApp({
      share: {
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
        contentItemIds: [ITEM_ID],
      },
    });

    const response = await app.request(sharePath(crypto.randomUUID()), {}, testEnv);

    expect(response.status).toBe(404);
  });

  it('a Redis outage fails the share path closed', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
    });

    const response = await app.request(
      sharePath(crypto.randomUUID()),
      {},
      {
        ...testEnv,
        UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:1',
      }
    );

    expect(response.status).toBe(503);
  });

  it('a malformed content item id is rejected at the boundary', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath('not-a-uuid'),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('a malformed shareId is rejected at the boundary', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
    });

    const response = await app.request(sharePath('not-a-uuid'), {}, testEnv);

    expect(response.status).toBe(400);
  });

  it('re-mints past the per-shareId cap are rate limited', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
    });
    const shareId = crypto.randomUUID();
    const max = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit.maxAttempts;
    for (let attempt = 0; attempt < max; attempt += 1) {
      await unwrap(reserveShareRemint(redis, shareId));
    }

    const response = await app.request(sharePath(shareId), {}, testEnv);

    expect(response.status).toBe(429);
    const body = errorBodySchema.parse(await response.json());
    expect(body.code).toBe(ERROR_CODES.RATE_LIMITED);
  });

  it('a rate-limited caller never reaches the share lookup', async () => {
    let lookups = 0;
    const app = createApp(
      {},
      {
        readers: () => ({
          ...fakeReaders({
            share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
          }),
          shares: {
            findShare: () => {
              lookups += 1;
              return okAsync({ revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] });
            },
          },
        }),
      }
    );
    const shareId = crypto.randomUUID();
    const max = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit.maxAttempts;
    for (let attempt = 0; attempt < max; attempt += 1) {
      await unwrap(reserveShareRemint(redis, shareId));
    }

    await app.request(sharePath(shareId), {}, testEnv);

    expect(lookups).toBe(0);
  });
});
