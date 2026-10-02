import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { Mode } from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import { createApp } from '../app.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from '../middleware/pipeline-admin.js';
import { hashRateLimitId } from '../middleware/rate-limit.js';
import { adminDashboardRateLimit, adminOpsRateLimit } from '../slices/admin/index.js';
import { rateLimitKey } from '../lib/rate-limit/index.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/**
 * The admin ops window is a throttle: it clears on no success and `clear`
 * cannot reach it, so the ONLY way back under a spent window is the dev reset.
 * These cases prove that end to end against a real Redis — a window at its cap
 * refuses, the reset runs, the same request is admitted — rather than asserting
 * the reset's glob and inferring the effect.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`admin ops reset tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

function panelUrl(): string {
  const url = new URL(DATABASE_URL);
  url.username = 'admin_sql_panel';
  url.password = 'admin_sql_panel';
  return url.toString();
}

/**
 * A unique actor per run: the window is keyed on the hashed Access email, so a
 * fixed address would share its counter with any concurrent run of this file.
 */
const ADMIN_EMAIL = `ops-reset-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;

const devEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
  CF_ACCESS_TEAM_DOMAIN: 'hushbox-dev',
  CF_ACCESS_AUD: 'dev-admin-access-aud',
  ADMIN_ACTOR_ALLOWLIST: ADMIN_EMAIL,
  ADMIN_ROLE_MAP: `${ADMIN_EMAIL}=operator`,
  CF_ACCESS_DEV_PRIVATE_JWK: envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development],
  ADMIN_SQL_PANEL_DATABASE_URL: panelUrl(),
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const app = createApp();
const spentKeys: string[] = [];

afterAll(async () => {
  if (spentKeys.length > 0) await redis.del(...spentKeys);
});

/** The counter the pipeline spends for this actor, through the encoder `consume` keys with. */
async function opsWindowKey(): Promise<string> {
  const key = rateLimitKey(adminOpsRateLimit, await hashRateLimitId(ADMIN_EMAIL))._unsafeUnwrap();
  spentKeys.push(key);
  return key;
}

/**
 * One op preview as the console would send it. The op is deliberately
 * unregistered: what this asserts is whether the request got PAST the limiter,
 * and an unregistered name answers without running an operation.
 */
async function previewUnregisteredOp(): Promise<Response> {
  const token = await mintDevAdminToken(devEnv, { email: ADMIN_EMAIL });
  return app.request(
    '/admin/ops/fixture.notRegistered/preview',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CF_ACCESS_JWT_HEADER]: token,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ input: {} }),
    },
    devEnv
  );
}

async function runReset(): Promise<Response> {
  return app.request('/dev/admin-ops-runs', { method: 'DELETE' }, devEnv);
}

describe('DELETE /dev/admin-ops-runs', () => {
  it('turns an ops request refused at the cap into an admitted one', async () => {
    // Seeded AT the cap, so the next attempt is the one past it and is
    // refused. That refusal is the control: without it, an admitted request
    // after the reset would prove nothing about the reset.
    const key = await opsWindowKey();
    await redis.set(key, adminOpsRateLimit.maxAttempts, {
      ex: adminOpsRateLimit.windowSeconds,
    });

    const refused = await previewUnregisteredOp();
    const reset = await runReset();
    const admitted = await previewUnregisteredOp();

    expect(refused.status).toBe(429);
    expect(reset.status).toBe(200);
    expect(admitted.status).not.toBe(429);
  });

  it('is unreachable in production', async () => {
    // The barrier is the `dev-only` route class, NOT the mount: `app.ts` mounts
    // the dev manifest unconditionally, so a reader who checks the mount will
    // conclude wrongly. What refuses is the class gate, and this asserts the
    // route carries it — a reset that could be invoked against production
    // Redis is the one way this endpoint could do harm.
    const productionApp = createApp();

    const response = await productionApp.request(
      '/dev/admin-ops-runs',
      { method: 'DELETE' },
      { ...devEnv, NODE_ENV: 'production' }
    );

    expect(response.status).toBe(404);
  });

  it('leaves a sibling admin window standing', async () => {
    // The over-reach direction, against a real keyspace: a glob widened to
    // `ratelimit:admin:*` would clear the dashboard's window too.
    const actorHash = await hashRateLimitId(ADMIN_EMAIL);
    const ops = rateLimitKey(adminOpsRateLimit, actorHash)._unsafeUnwrap();
    const dashboard = rateLimitKey(adminDashboardRateLimit, actorHash)._unsafeUnwrap();
    spentKeys.push(ops, dashboard);
    await redis.set(ops, 5, { ex: adminOpsRateLimit.windowSeconds });
    await redis.set(dashboard, 7, { ex: adminDashboardRateLimit.windowSeconds });

    const reset = await runReset();

    expect(reset.status).toBe(200);
    expect(await redis.get(ops)).toBeNull();
    expect(await redis.get(dashboard)).toBe(7);
  });
});
