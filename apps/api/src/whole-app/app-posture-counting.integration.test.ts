import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { createApp } from '../app.js';
import { routeClass } from '../middleware/pipeline-markers.js';
import { bindRoutePosture, rateLimitKey } from '../lib/rate-limit/index.js';
import { callerIpIdForAddress } from '../lib/redis/index.js';
import { loginIpRateLimit } from '../slices/identity/index.js';
import type { Hono } from 'hono';
import type { RoutePostureMap } from '../middleware/pipeline-rate-limit.js';
import type { ThrottleLimit } from '../lib/rate-limit/index.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`posture-counting tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

const devEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const keysToClean: string[] = [];
afterAll(async () => {
  for (const key of keysToClean) await redis.del(key);
});

function octet(): string {
  return String(Math.floor(Math.random() * 255));
}
function uniqueIp(): string {
  return `10.${octet()}.${octet()}.${octet()}`;
}

/**
 * A route the posture map declares and NO limiter is mounted on — the exact
 * shape the stage is here to bound. Its cap is small so the reading is a cap
 * rather than a volume: what matters is that the admitted count equals
 * `maxAttempts` and the rest are refused, offered all at once.
 */
const probeLimit = {
  kind: 'throttle',
  maxAttempts: 3,
  windowSeconds: 60,
  buildKey: (id: string) => `posture-counting:probe:${id}`,
} as const satisfies ThrottleLimit;

const PROBE_POSTURES: RoutePostureMap = {
  '$get /posture-probe': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: probeLimit }],
  }),
};

function probeApp(): Hono<AppEnv> {
  return createApp(PROBE_POSTURES).get('/posture-probe', routeClass('public'), (c) =>
    c.json({ ok: true })
  ) as unknown as Hono<AppEnv>;
}

describe('the pipeline stage counts a declared route no limiter is mounted on', () => {
  it('admits exactly the declared cap when more than the cap arrive at once', async () => {
    const app = probeApp();
    const ip = uniqueIp();
    keysToClean.push(rateLimitKey(probeLimit, await callerIpIdForAddress(ip))._unsafeUnwrap());
    const headers = { 'cf-connecting-ip': ip };
    const offered = 20;

    const responses = await Promise.all(
      Array.from({ length: offered }, async () =>
        app.request('/posture-probe', { headers }, devEnv)
      )
    );
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status !== 429)).toHaveLength(probeLimit.maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(
      offered - probeLimit.maxAttempts
    );
  });

  it('counts each caller under its own window rather than one shared counter', async () => {
    const app = probeApp();
    const first = uniqueIp();
    const second = uniqueIp();
    keysToClean.push(
      rateLimitKey(probeLimit, await callerIpIdForAddress(first))._unsafeUnwrap(),
      rateLimitKey(probeLimit, await callerIpIdForAddress(second))._unsafeUnwrap()
    );

    for (let attempt = 0; attempt <= probeLimit.maxAttempts; attempt += 1) {
      await app.request('/posture-probe', { headers: { 'cf-connecting-ip': first } }, devEnv);
    }
    const other = await app.request(
      '/posture-probe',
      { headers: { 'cf-connecting-ip': second } },
      devEnv
    );

    expect(other.status).toBe(200);
  });
});

/**
 * The named behaviour change. A root `.use(path, limiter)` mount fired on any
 * method reaching its path, so a probe with a method no route serves consumed
 * a window on its way to a 404. The stage keys on the ROUTE — method and path
 * — so such a probe now 404s having spent nothing. Nothing becomes unbounded:
 * a 404 does no backend work, and every method the router does serve is
 * declared.
 */
describe('a probe with a method the path serves no route for', () => {
  it('404s without spending the window that bounds the real route on that path', async () => {
    const app = createApp();
    const ip = uniqueIp();
    const windowKey = rateLimitKey(
      loginIpRateLimit,
      await callerIpIdForAddress(ip)
    )._unsafeUnwrap();
    keysToClean.push(windowKey);

    const res = await app.request(
      '/auth/login/init',
      { method: 'DELETE', headers: { 'cf-connecting-ip': ip } },
      devEnv
    );

    expect(res.status).toBe(404);
    expect(await redis.get(windowKey)).toBeNull();
  });

  it('still bounds the method that path does serve', async () => {
    const app = createApp();
    const ip = uniqueIp();
    const windowKey = rateLimitKey(
      loginIpRateLimit,
      await callerIpIdForAddress(ip)
    )._unsafeUnwrap();
    keysToClean.push(windowKey);

    await app.request(
      '/auth/login/init',
      {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' },
        body: '{}',
      },
      devEnv
    );

    expect(await redis.get(windowKey)).toBe(1);
  });
});
