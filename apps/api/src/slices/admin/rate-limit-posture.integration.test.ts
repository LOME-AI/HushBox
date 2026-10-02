import { Redis } from '@upstash/redis';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { Mode } from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import { applyPipeline } from '../../middleware/pipeline.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from '../../middleware/pipeline-admin.js';
import { hashRateLimitId } from '../../middleware/rate-limit.js';
import { adminOpsRateLimit } from './domain/rate-limit.js';
import { createAdminStores } from './adapters/stores.js';
import { createAdminOpEngine } from './domain/engine.js';
import { createAdminFixtureRegistry } from './domain/fixture-ops.js';
import { ADMIN_ROUTE_POSTURES } from './rate-limit-posture.js';
import { ADMIN_ROUTE_ROLES } from '../../composition/admin-route-roles.js';
import { createAdminManifest } from './routes.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { AdminFixtureDeps, AdminFixturePostDeps } from './domain/fixture-ops.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`admin posture integration tests: missing ${name}. Run via a package script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

/** Unique per run: the ops window is hourly and no dev reset clears it. */
const RUN_ID = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
const ALLOWLISTED = [
  `admin-ops-limit-a-${RUN_ID}@hushbox.test`,
  `admin-ops-limit-b-${RUN_ID}@hushbox.test`,
  `admin-ops-limit-c-${RUN_ID}@hushbox.test`,
] as const;

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  CF_ACCESS_TEAM_DOMAIN: 'hushbox-dev',
  CF_ACCESS_AUD: 'dev-admin-access-aud',
  ADMIN_ACTOR_ALLOWLIST: ALLOWLISTED.join(','),
  ADMIN_ROLE_MAP: ALLOWLISTED.map((email) => `${email}=operator`).join(','),
  CF_ACCESS_DEV_PRIVATE_JWK: envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development],
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const spentKeys: string[] = [];

const registry = createAdminFixtureRegistry();
const stores = createAdminStores();

/** No op body runs here: every request below names an unregistered op, so the
 * engine answers not-found before it opens a transaction. */
function unreached(): never {
  throw new Error('the admin posture suite runs no op body');
}

const fixtureDeps: AdminFixtureDeps = {
  scratch: { markWithinTx: unreached, unmarkWithinTx: unreached },
};
const fixturePostDeps: AdminFixturePostDeps = {
  ephemeralLog: [],
  ephemeralFailure: { armed: false },
};

/**
 * The ops routes over the REAL posture map, so what refuses below is the
 * declaration this slice publishes and not a limiter the test wired itself.
 */
function createApp(): Hono<AppEnv> {
  const manifest = createAdminManifest({
    listOps: () => registry.list(),
    prefill: () => null,
    reads: () => {
      throw new Error('the read surface is not under test in this suite');
    },
    engine: (requestDb, telemetry) =>
      createAdminOpEngine({
        db: requestDb,
        registry,
        stores,
        telemetry,
        opDeps: fixtureDeps,
        postDeps: fixturePostDeps,
        executorId: `admin-ops-limit-${RUN_ID}`,
      }),
  });
  const app = applyPipeline(new Hono<AppEnv>(), {
    admin: { routeRoles: ADMIN_ROUTE_ROLES },
    rateLimit: { postures: ADMIN_ROUTE_POSTURES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/**
 * The counter the pipeline would spend for this actor: the entry's key, through
 * the encoder `consume` keys with, over the hash the `admin-actor` identity
 * resolves to, never a respelled template.
 */
async function opsWindowKey(email: string): Promise<string> {
  const key = rateLimitKey(adminOpsRateLimit, await hashRateLimitId(email))._unsafeUnwrap();
  spentKeys.push(key);
  return key;
}

async function post(path: string, email: string, body: unknown): Promise<Response> {
  const token = await mintDevAdminToken(testEnv, { email });
  return createApp().request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CF_ACCESS_JWT_HEADER]: token,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

const UNREGISTERED = 'fixture.notRegistered';

afterAll(async () => {
  if (spentKeys.length > 0) await redis.del(...spentKeys);
});

describe('the admin operations window', () => {
  it('admits the last attempt of an actor’s window and refuses the one past it', async () => {
    // Seeded one short of the cap, so the boundary is shown inclusive: the
    // request that lands ON the cap is admitted, and the next one is refused.
    const email = ALLOWLISTED[0];
    const key = await opsWindowKey(email);
    await redis.set(key, adminOpsRateLimit.maxAttempts - 1, {
      ex: adminOpsRateLimit.windowSeconds,
    });

    const onTheCap = await post(`/admin/ops/${UNREGISTERED}/preview`, email, { input: {} });
    const pastTheCap = await post(`/admin/ops/${UNREGISTERED}/preview`, email, { input: {} });

    expect(onTheCap.status).not.toBe(429);
    expect(pastTheCap.status).toBe(429);
  });

  it('bounds preview and execute on one shared window', async () => {
    // Preview spends the window to its cap; execute — a different route — is
    // then the attempt past it, so neither is the free half of the pair.
    const email = ALLOWLISTED[1];
    const key = await opsWindowKey(email);
    await redis.set(key, adminOpsRateLimit.maxAttempts - 1, {
      ex: adminOpsRateLimit.windowSeconds,
    });

    const preview = await post(`/admin/ops/${UNREGISTERED}/preview`, email, { input: {} });
    const execute = await post(`/admin/ops/${UNREGISTERED}/execute`, email, { input: {} });

    expect(preview.status).not.toBe(429);
    expect(execute.status).toBe(429);
  });

  it('leaves an actor with an unspent window admitted past the limiter', async () => {
    // The discrimination for the two refusals above: with nothing spent, the
    // same request reaches the handler, which answers the unregistered op.
    const email = ALLOWLISTED[2];
    await redis.del(await opsWindowKey(email));

    const admitted = await post(`/admin/ops/${UNREGISTERED}/preview`, email, { input: {} });

    expect(admitted.status).toBe(404);
  });
});
