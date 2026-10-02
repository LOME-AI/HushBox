import { describe, it } from 'vitest';
import { Hono } from 'hono';
import { LINEAR_TEAM_KEY } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { proveCallerInvariance } from '../../test-support/caller-invariance.js';
import { MOCK_ISSUES, MOCK_PROJECTS } from './adapters/mock-roadmap-fixture.js';
import { createRoadmapManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { LinearClient, LinearRoadmapData } from './ports/index.js';

/**
 * The public roadmap board is declared storable by a shared cache, which
 * licenses replaying one caller's response to a stranger. This is the proof
 * that claim rests on; the arch rule `cacheable-routes-prove-caller-invariance`
 * requires it to exist.
 *
 * Both responses are BUILT: the route fetches and normalizes the board on every
 * call and holds no copy of its own, so neither caller can be answered out of
 * the other's.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the roadmap caller-invariance proof`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

const SESSION_SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: SESSION_SECRET,
  TELEMETRY_SINKS: 'console',
};

const linear: LinearClient = {
  fetchRoadmap: (): Promise<LinearRoadmapData> =>
    Promise.resolve({ projects: MOCK_PROJECTS, issues: MOCK_ISSUES }),
};

function createApp(): Hono<AppEnv> {
  const manifest = createRoadmapManifest({ linear: () => linear, teamKey: LINEAR_TEAM_KEY });
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

describe('GET /public/roadmap is invariant across callers', () => {
  it('answers a session, an address, credentials and a query with identical bytes', async () => {
    await proveCallerInvariance('$get /public/roadmap', {
      path: '/public/roadmap',
      sessionSecret: SESSION_SECRET,
      databaseUrl: DATABASE_URL,
      // The board is the whole of the answer. A per-user view grown here
      // would arrive with a table whose row goes in this hook.
      seedIdentifiedState: () => Promise.resolve(),
      respondTo: async ({ path, headers }) => createApp().request(path, { headers }, testEnv),
    });
  });
});
