import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { TRIAL_MESSAGE_LIMIT } from '@hushbox/shared';
import { createApp } from '../app.js';
import { callerIpIdForAddress } from '../lib/redis/index.js';
import { resendVerifyIpRateLimit } from '../slices/identity/index.js';
import { trialQuotaIpKey } from '../slices/chat/index.js';
import {
  STARTED,
  fakeRealtime,
  pinTrialCatalogBaseline,
  postTrial,
  seedInheritedCatalogRows,
} from '../test-support/chat-routes.integration.setup.js';
import { rateLimitKey } from '../lib/rate-limit/index.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`redis reset scoping tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

const devEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/**
 * The cheapest per-IP auth throttle to exhaust (5 per 60s), so a window costs
 * five requests rather than twenty. Which entry it is does not matter: every
 * per-IP entry keys the same way.
 */
const LIMIT = resendVerifyIpRateLimit;
const PATH = '/auth/verify-email/resend';

const windowKeysToClean: string[] = [];

afterAll(async () => {
  for (const key of windowKeysToClean) {
    await redis.del(key);
  }
});

/** A caller address no concurrently-running file can collide with. */
function uniqueIp(): string {
  return `10.${[...crypto.getRandomValues(new Uint8Array(3))].join('.')}`;
}

async function trackWindow(ip: string): Promise<void> {
  windowKeysToClean.push(rateLimitKey(LIMIT, await callerIpIdForAddress(ip))._unsafeUnwrap());
}

type App = ReturnType<typeof createApp>;

/**
 * One throttled request. The body is empty on purpose: the pipeline spends the
 * per-IP limiter ahead of the manifest's validator, so an admitted request
 * answers 400 and only a refused one answers 429.
 */
async function attempt(app: App, ip: string): Promise<number> {
  const res = await app.request(
    PATH,
    {
      method: 'POST',
      headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' },
      body: '{}',
    },
    devEnv
  );
  return res.status;
}

/** Spends the whole window for `ip`, leaving the next attempt over the cap. */
async function spendWindow(app: App, ip: string): Promise<void> {
  for (let spent = 0; spent < LIMIT.maxAttempts; spent += 1) {
    expect(await attempt(app, ip)).not.toBe(429);
  }
}

describe('per-IP auth throttles across caller identities', () => {
  it('refuses only the identity that exhausted the window', async () => {
    const app = createApp();
    const exhausted = uniqueIp();
    const untouched = uniqueIp();
    await trackWindow(exhausted);
    await trackWindow(untouched);

    await spendWindow(app, exhausted);

    expect(await attempt(app, exhausted)).toBe(429);
    expect(await attempt(app, untouched)).not.toBe(429);
  });
});

/**
 * One trial send from `ip`, on a session no other send shares — so the 5/day
 * verdict is decided by the per-IP counter alone (the send spends both, and
 * admits only when both hold).
 */
async function trialSend(ip: string): Promise<number> {
  const res = await postTrial(
    fakeRealtime(STARTED),
    {
      'Idempotency-Key': crypto.randomUUID(),
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': ip,
    },
    { turnSources: [{ kind: 'smart' }], prompt: 'hi' }
  );
  return res.status;
}

async function spendTrialQuota(ip: string): Promise<void> {
  for (let spent = 0; spent < TRIAL_MESSAGE_LIMIT; spent += 1) {
    expect(await trialSend(ip)).toBe(201);
  }
  trialKeysToClean.push(
    trialQuotaIpKey(new Date(), await callerIpIdForAddress(ip))._unsafeUnwrap()
  );
}

const trialKeysToClean: string[] = [];

afterAll(async () => {
  for (const key of trialKeysToClean) {
    await redis.del(key);
  }
});

describe('DELETE /dev/trial-usage', () => {
  // Rows an earlier test file left in this worker slot's catalog, which the
  // premium percentile is taken over. Seeded before the baseline below, so the
  // baseline rather than the slot is what this case's sends are judged against.
  beforeAll(seedInheritedCatalogRows);
  beforeEach(pinTrialCatalogBaseline);

  it('clears only the calling identity’s trial quota counter', async () => {
    const app = createApp();
    const caller = uniqueIp();
    const other = uniqueIp();
    await spendTrialQuota(caller);
    await spendTrialQuota(other);
    expect(await trialSend(caller)).toBe(429);
    expect(await trialSend(other)).toBe(429);

    const res = await app.request(
      '/dev/trial-usage',
      { method: 'DELETE', headers: { 'cf-connecting-ip': caller } },
      devEnv
    );

    expect(res.status).toBe(200);
    expect(await trialSend(caller)).toBe(201);
    expect(await trialSend(other)).toBe(429);
  });
});

describe('DELETE /dev/auth-rate-limits', () => {
  it('clears only the calling identity’s per-IP windows', async () => {
    const app = createApp();
    const caller = uniqueIp();
    const other = uniqueIp();
    await trackWindow(caller);
    await trackWindow(other);
    await spendWindow(app, caller);
    await spendWindow(app, other);
    expect(await attempt(app, caller)).toBe(429);
    expect(await attempt(app, other)).toBe(429);

    const res = await app.request(
      '/dev/auth-rate-limits',
      {
        method: 'DELETE',
        headers: { 'cf-connecting-ip': caller, 'content-type': 'application/json' },
        // No account named: this case is about the per-IP dimension alone, and
        // the endpoint can no longer reach an account it was not given.
        body: JSON.stringify({ identifiers: [] }),
      },
      devEnv
    );

    expect(res.status).toBe(200);
    expect(await attempt(app, caller)).not.toBe(429);
    expect(await attempt(app, other)).toBe(429);
  });
});

/**
 * Keys under a namespace no reset glob reaches, so they widen the keyspace a
 * walk crosses without being anything the reset deletes.
 */
const INFLATION_KEYS = 1200;

const inflationKeys: string[] = [];

afterAll(async () => {
  for (let start = 0; start < inflationKeys.length; start += 256) {
    await redis.del(...inflationKeys.slice(start, start + 256));
  }
});

async function inflateKeyspace(): Promise<void> {
  const run = crypto.randomUUID();
  const filler = Object.fromEntries(
    Array.from({ length: INFLATION_KEYS }, (_, index) => [
      `dev-reset-inflation:${run}:${String(index)}`,
      '1',
    ])
  );
  inflationKeys.push(...Object.keys(filler));
  await redis.mset(filler);
}

/** The target of a fetch call, in whichever of the three forms it was made with. */
function targetUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * How many HTTP round trips to Redis the work inside `body` cost.
 *
 * It counts at the global `fetch` the Upstash client reaches for, which sits
 * OUTSIDE the harness's run scoping — so the scoping's own `COMMAND INFO` and
 * `COMMAND GETKEYS` probes, which no production or E2E caller pays, are not
 * counted and the figure is the one the running system would pay.
 */
async function redisRoundTrips(body: () => Promise<void>): Promise<number> {
  const inner = globalThis.fetch;
  let trips = 0;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (targetUrl(input).startsWith(UPSTASH_REDIS_REST_URL)) trips += 1;
    return inner(input, init);
  }) as typeof globalThis.fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = inner;
  }
  return trips;
}

describe('DELETE /dev/usage-rate-limits', () => {
  it('costs the same Redis round trips whatever the keyspace holds', async () => {
    // The property the per-test fixture depends on: this endpoint runs before
    // every E2E test, so a cost that rises with the keyspace makes an unrelated
    // seed a suite-wide slowdown. Measured rather than argued, against two
    // keyspaces an order of magnitude apart.
    const app = createApp();
    const caller = uniqueIp();
    const reset = async (): Promise<void> => {
      const res = await app.request(
        '/dev/usage-rate-limits',
        { method: 'DELETE', headers: { 'cf-connecting-ip': caller } },
        devEnv
      );
      expect(res.status).toBe(200);
    };

    const small = await redisRoundTrips(reset);
    await inflateKeyspace();
    const inflated = await redisRoundTrips(reset);

    expect(inflated).toBe(small);
  });
});
