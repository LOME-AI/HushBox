import { afterAll, describe, it } from 'vitest';
import { Hono } from 'hono';
import { LOCAL_NEON_DEV_CONFIG, bannerConfig, bannerDismissals, createDb } from '@hushbox/db';
import { hashCanonicalJson } from '../../lib/idempotency/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { proveCallerInvariance } from '../../test-support/caller-invariance.js';
import { createAnnouncementsManifest, createAnnouncementsStores } from './index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

/**
 * The public half of the banner is declared storable by a shared cache, which
 * licenses replaying one caller's response to a stranger. What makes that safe
 * is the split: the payload comes from the global config row, and the per-user
 * dismissal state lives on a `session`-classed route of its own. This is the
 * proof of the public half; the arch rule
 * `cacheable-routes-prove-caller-invariance` requires it to exist.
 *
 * The split is exactly what this proof has to be able to see collapse, so the
 * identified caller arrives having dismissed the live message set: folding the
 * dismissal filter back into this route would answer that caller a different
 * body, and the byte comparison in `apps/api/src/test-support/caller-invariance.ts`
 * is what refuses it.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('DATABASE_URL is required for the banner caller-invariance proof');
}

const SESSION_SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SESSION_SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** An enabled set, so the proof runs over a hash and messages rather than the
 * empty payload an absent row answers with. */
const MESSAGES = [{ text: 'scheduled maintenance', variant: 'warning' as const }];

function createApp(): Hono<AppEnv> {
  const manifest = createAnnouncementsManifest({ stores: createAnnouncementsStores });
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

afterAll(async () => {
  await db.delete(bannerConfig);
  await db.$client.end();
});

describe('GET /announcements/banner is invariant across callers', () => {
  it('answers a session, an address, credentials and a query with identical bytes', async () => {
    await db.delete(bannerConfig);
    await db.insert(bannerConfig).values({ enabled: true, messages: MESSAGES });

    await proveCallerInvariance('$get /announcements/banner', {
      path: '/announcements/banner',
      sessionSecret: SESSION_SECRET,
      databaseUrl: DATABASE_URL,
      seedIdentifiedState: async (userId) => {
        await db.insert(bannerDismissals).values({
          userId,
          messageSetHash: await hashCanonicalJson({ messages: MESSAGES }),
        });
      },
      respondTo: async ({ path, headers }) => createApp().request(path, { headers }, testEnv),
    });
  });
});
