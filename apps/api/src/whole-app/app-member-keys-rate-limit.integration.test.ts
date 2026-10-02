import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { sealData } from 'iron-session';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { createApp } from '../app.js';
import { SESSION_COOKIE_NAME } from '../middleware/pipeline-session.js';
import { memberKeysBatchRateLimit } from '../slices/conversations/index.js';
import { IDENTITY_KEYS } from '../slices/identity/domain/keys.js';
import { rateLimitKey } from '../lib/rate-limit/index.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `member-keys rate-limit tests: missing ${name}. Run via a package test script.`
    );
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
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const BYTES = new Uint8Array([1, 2, 3]);
const seededUserIds: string[] = [];
const keysToClean: string[] = [];

/**
 * The largest batch the query schema admits. A cold launch pages the
 * conversation list at this width, so the number of batch requests a launch
 * issues is the account's conversation count divided by it.
 */
const BATCH_CEILING = 100;

async function newCaller(): Promise<{ cookie: string; key: string }> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@member-keys-ratelimit.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: crypto.getRandomValues(new Uint8Array(32)),
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = rows[0]?.id ?? '';
  seededUserIds.push(userId);
  const sessionId = `session-${userId}`;
  const activeKey = IDENTITY_KEYS.sessionActive.buildKey(userId, sessionId);
  keysToClean.push(activeKey);
  await redis.set(activeKey, '1', { ex: IDENTITY_KEYS.sessionActive.ttlSeconds });
  const sealed = await sealData(
    {
      userId,
      sessionId,
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  const key = rateLimitKey(memberKeysBatchRateLimit, userId)._unsafeUnwrap();
  keysToClean.push(key);
  await redis.del(key);
  return { cookie: `${SESSION_COOKIE_NAME}=${sealed}`, key };
}

function batchRequest(cookie: string, idCount: number): [string, RequestInit] {
  const ids = Array.from({ length: idCount }, () => crypto.randomUUID()).join(',');
  return [
    `/conversations/member-keys/batch?conversationIds=${ids}`,
    { method: 'GET', headers: { cookie } },
  ];
}

beforeAll(async () => {
  await redis.ping();
});

afterAll(async () => {
  if (keysToClean.length > 0) await redis.del(...keysToClean);
  if (seededUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.$client.end();
});

describe('composed app: the batch keychain read is capped per account', () => {
  it('refuses a maximum-size batch once the account has spent its window', async () => {
    const app = createApp();
    const { cookie, key } = await newCaller();
    await redis.set(key, memberKeysBatchRateLimit.maxAttempts, {
      ex: memberKeysBatchRateLimit.windowSeconds,
    });

    const [path, init] = batchRequest(cookie, BATCH_CEILING);
    const refused = await app.request(path, init, devEnv);

    expect(refused.status).toBe(429);
  });

  it('admits a cold launch of the conversation-count ceiling without refusing one page', async () => {
    const app = createApp();
    const { cookie } = await newCaller();
    // Ten full pages — a thousand conversations, far beyond any real account,
    // and still inside the window this cap allows.
    const pages = 10;

    const statuses: number[] = [];
    for (let page = 0; page < pages; page += 1) {
      const [path, init] = batchRequest(cookie, BATCH_CEILING);
      const response = await app.request(path, init, devEnv);
      statuses.push(response.status);
    }

    expect(statuses).toEqual(Array.from({ length: pages }, () => 200));
  });
});
