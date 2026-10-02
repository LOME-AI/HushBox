import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { sealData } from 'iron-session';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { toBase64 } from '@hushbox/shared';
import { createApp } from '../app.js';
import { SESSION_COOKIE_NAME } from '../middleware/pipeline-session.js';
import { callerIpIdForAddress } from '../lib/redis/index.js';
import {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  verifyEmailIpRateLimit,
} from '../slices/identity/index.js';
import { linkCreateRateLimit, shareCreateRateLimit } from '../slices/conversations/index.js';
import { userSearchRateLimit } from '../slices/account/index.js';
import { rateLimitKey } from '../lib/rate-limit/index.js';
import type { RateLimitDefinition } from '../lib/rate-limit/index.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`auth rate-limit tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

const SECRET = 'secret-at-least-32-characters-long!!';
const devEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

// Unique per invocation so a concurrent suite never shares a window.
function octet(): string {
  return String(Math.floor(Math.random() * 255));
}
function uniqueIp(): string {
  return `10.${octet()}.${octet()}.${octet()}`;
}

const ipKeysToClean: string[] = [];
const createdUserIds: string[] = [];
const sessionKeysToClean: string[] = [];
const shareKeysToClean: string[] = [];
const linkKeysToClean: string[] = [];
const searchKeysToClean: string[] = [];

afterAll(async () => {
  for (const key of [
    ...ipKeysToClean,
    ...sessionKeysToClean,
    ...shareKeysToClean,
    ...linkKeysToClean,
    ...searchKeysToClean,
  ]) {
    await redis.del(key);
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

const jsonHeaders = (ip: string): Record<string, string> => ({
  'cf-connecting-ip': ip,
  'content-type': 'application/json',
});

// The auth per-IP caps are declared in the slice's posture fragment and spent
// by the pipeline stage, so only a request through the real composed app proves
// the declaration reaches the route. Each request carries an empty body: the
// stage runs ahead of the manifest's zValidator, so an admitted request
// answers a non-429 (400 invalid body), and the over-cap request answers 429.
async function assertIpCap(path: string, definition: RateLimitDefinition): Promise<void> {
  const app = createApp();
  const ip = uniqueIp();
  ipKeysToClean.push(rateLimitKey(definition, await callerIpIdForAddress(ip))._unsafeUnwrap());
  const headers = jsonHeaders(ip);
  const { maxAttempts } = definition;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await app.request(path, { method: 'POST', headers, body: '{}' }, devEnv);
    expect(res.status).not.toBe(429);
  }
  const refused = await app.request(path, { method: 'POST', headers, body: '{}' }, devEnv);
  expect(refused.status).toBe(429);
}

describe('composed app: auth per-IP abuse throttles', () => {
  it('caps login start per IP (20/900)', async () => {
    await assertIpCap('/auth/login/init', loginIpRateLimit);
  });

  it('caps registration start per IP (10/3600)', async () => {
    await assertIpCap('/auth/register/init', registerIpRateLimit);
  });

  it('caps recovery reset start per IP (10/3600)', async () => {
    await assertIpCap('/auth/recovery/reset/init', recoveryResetIpRateLimit);
  });

  it('caps recovery wrapped-key retrieval per IP (10/3600)', async () => {
    await assertIpCap('/auth/recovery/get-wrapped-key', recoveryGetKeyIpRateLimit);
  });

  it('caps email-verification consume per IP (30/3600)', async () => {
    await assertIpCap('/auth/verify-email', verifyEmailIpRateLimit);
  });

  it('caps verification-email resend per IP (5/60)', async () => {
    await assertIpCap('/auth/verify-email/resend', resendVerifyIpRateLimit);
  });

  it('caps billing-portal token login per IP (20/600)', async () => {
    await assertIpCap('/auth/token-login', tokenLoginIpRateLimit);
  });

  /**
   * Offered ALL AT ONCE, never in sequence: a cap that only holds when
   * requests arrive one at a time is not a cap (CODE-RULES §Security), and a
   * sequential loop cannot tell the two apart. Token redemption is the
   * surface where that matters most — the credential being guessed is the
   * request body, so an attacker controls how many guesses are in flight.
   */
  it('admits exactly its cap when more than its cap of token redemptions race', async () => {
    const app = createApp();
    const ip = uniqueIp();
    ipKeysToClean.push(
      rateLimitKey(tokenLoginIpRateLimit, await callerIpIdForAddress(ip))._unsafeUnwrap()
    );
    const headers = jsonHeaders(ip);
    const overCap = 5;

    const responses = await Promise.all(
      Array.from({ length: tokenLoginIpRateLimit.maxAttempts + overCap }, async () =>
        app.request('/auth/token-login', { method: 'POST', headers, body: '{}' }, devEnv)
      )
    );
    const statuses = responses.map((res) => res.status);

    expect(statuses.filter((status) => status !== 429)).toHaveLength(
      tokenLoginIpRateLimit.maxAttempts
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(overCap);
  });
});

/**
 * A live full session: seed the user, mark the session active in Redis (the
 * composed app runs the revocation check), and seal the cookie.
 */
async function liveSessionUser(usernamePrefix: string): Promise<{
  readonly userId: string;
  readonly cookie: string;
}> {
  const username = `${usernamePrefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const bytes = new Uint8Array([3, 3, 3]);
  const [row] = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@auth-ratelimit.test`,
        username,
        opaqueRegistration: bytes,
        publicKey: crypto.getRandomValues(new Uint8Array(32)),
        passwordWrappedPrivateKey: bytes,
        recoveryWrappedPrivateKey: bytes,
        recoveryPublicKey: bytes,
      })
    )
    .returning({ id: users.id });
  const userId = row?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);

  const sessionId = `session-${userId}`;
  const sessionKey = `sessions:user:active:${userId}:${sessionId}`;
  await redis.set(sessionKey, '1', { ex: 3600 });
  sessionKeysToClean.push(sessionKey);

  const sealed = await sealData(
    { userId, sessionId, createdAt: Date.now(), pending2FA: false, pending2FAExpiresAt: 0 },
    { password: SECRET }
  );
  return { userId, cookie: `${SESSION_COOKIE_NAME}=${sealed}` };
}

describe('composed app: token-login counts a session-bearing caller', () => {
  /**
   * The declaration names `ip`, never `sessionless-ip`: the handler looks the
   * token up whatever principal presents it, so an identity that leaves full
   * principals uncounted would let one throwaway account brute-force the
   * token for free.
   */
  it('caps token redemption from a live session at its per-IP window', async () => {
    const { cookie } = await liveSessionUser('zztokn');
    const app = createApp();
    const ip = uniqueIp();
    ipKeysToClean.push(
      rateLimitKey(tokenLoginIpRateLimit, await callerIpIdForAddress(ip))._unsafeUnwrap()
    );
    const headers = { ...jsonHeaders(ip), cookie };
    const post = { method: 'POST', headers, body: '{}' };

    for (let attempt = 0; attempt < tokenLoginIpRateLimit.maxAttempts; attempt += 1) {
      const res = await app.request('/auth/token-login', post, devEnv);
      expect(res.status).not.toBe(429);
    }
    const refused = await app.request('/auth/token-login', post, devEnv);

    expect(refused.status).toBe(429);
  });
});

describe('composed app: shared-message creation per-caller cap', () => {
  it('caps authenticated share creation at 20/60 by caller, then 429s', async () => {
    const { userId, cookie } = await liveSessionUser('zzshare');
    shareKeysToClean.push(rateLimitKey(shareCreateRateLimit, userId)._unsafeUnwrap());

    const app = createApp();
    const path = `/conversations/${crypto.randomUUID()}/shares`;
    const body = JSON.stringify({
      messageId: crypto.randomUUID(),
      wrappedContentKey: toBase64(new Uint8Array([1, 2, 3])),
    });
    const { maxAttempts } = shareCreateRateLimit;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await app.request(
        path,
        {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body,
        },
        devEnv
      );
      // Admitted past the limiter (the fake conversation refuses), never 429.
      expect(res.status).not.toBe(429);
    }
    const refused = await app.request(
      path,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body,
      },
      devEnv
    );
    expect(refused.status).toBe(429);
  });
});

describe('composed app: user-search per-user throttle', () => {
  /**
   * Offered ALL AT ONCE, never in sequence: a cap that only holds when
   * requests arrive one at a time is not a cap (CODE-RULES §Security), and a
   * sequential loop cannot tell the two apart.
   */
  it('admits exactly its cap when more than its cap of searches race', async () => {
    const { userId, cookie } = await liveSessionUser('zzsrch');
    searchKeysToClean.push(rateLimitKey(userSearchRateLimit, userId)._unsafeUnwrap());

    const app = createApp();
    const path = `/account/users/search?q=zz&conversationId=${crypto.randomUUID()}`;
    const overCap = 5;

    const responses = await Promise.all(
      Array.from({ length: userSearchRateLimit.maxAttempts + overCap }, async () =>
        app.request(path, { headers: { cookie } }, devEnv)
      )
    );
    const statuses = responses.map((res) => res.status);

    expect(statuses.filter((status) => status !== 429)).toHaveLength(
      userSearchRateLimit.maxAttempts
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(overCap);
  });
});

describe('composed app: shared-link mint per-account cap', () => {
  /**
   * The mint shares its path with the link LIST, which is guest-reachable, so
   * the two have to be bounded separately; a posture is declared per route
   * key, which is method-scoped by construction, and the two arms below are
   * what say so.
   */
  function mintRequest(cookie: string, path: string): [string, RequestInit] {
    return [
      path,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: '{}',
      },
    ];
  }

  it('caps authenticated link minting at its window, then 429s', async () => {
    const { userId, cookie } = await liveSessionUser('zzlink');
    linkKeysToClean.push(rateLimitKey(linkCreateRateLimit, userId)._unsafeUnwrap());

    const app = createApp();
    const path = `/conversations/${crypto.randomUUID()}/links`;

    for (let attempt = 0; attempt < linkCreateRateLimit.maxAttempts; attempt += 1) {
      const res = await app.request(...mintRequest(cookie, path), devEnv);
      // Admitted past the limiter (the empty body is rejected), never 429.
      expect(res.status).not.toBe(429);
    }
    const refused = await app.request(...mintRequest(cookie, path), devEnv);

    expect(refused.status).toBe(429);
  });

  it('leaves the link list on the same path uncapped by the mint window', async () => {
    const { userId, cookie } = await liveSessionUser('zzlnkr');
    linkKeysToClean.push(rateLimitKey(linkCreateRateLimit, userId)._unsafeUnwrap());

    const app = createApp();
    const path = `/conversations/${crypto.randomUUID()}/links`;
    for (let attempt = 0; attempt <= linkCreateRateLimit.maxAttempts; attempt += 1) {
      await app.request(...mintRequest(cookie, path), devEnv);
    }

    const listed = await app.request(path, { headers: { cookie } }, devEnv);

    expect(listed.status).not.toBe(429);
  });

  it('never asks the per-user limiter to key a sessionless link-list read', async () => {
    // The stage THROWS when a `user`-keyed layer meets a principal that is not
    // full, so declaring one on the guest-reachable list would answer it with
    // a 500.
    const app = createApp();

    const listed = await app.request(
      `/conversations/${crypto.randomUUID()}/links`,
      undefined,
      devEnv
    );

    expect(listed.status).not.toBe(500);
  });
});
