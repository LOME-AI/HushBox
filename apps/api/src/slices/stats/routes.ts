import { Hono } from 'hono';
import { ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { buildPublicStats, createErrorResponse } from './domain/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { PublicStatsStores } from './domain/index.js';

interface StatsRouteDeps {
  readonly stores: PublicStatsStores;
}

/**
 * Public read-only anonymized usage-stats endpoint (no authentication):
 *
 * - per-IP rate-limited (30 / 60 s) via the edge window enforcer;
 * - sets no cache directive of its own; the lifetime only a shared cache in
 *   front of the Worker honors, and the cross-origin wildcard
 *   `middleware/cors.ts` grants off it, are declared in
 *   `apps/api/src/composition/route-cache-policy.ts`;
 * - any failure — including no snapshot row — surfaces as 503
 *   `SERVICE_UNAVAILABLE`; no fallback computation by design.
 */
export function createStatsManifest(deps: StatsRouteDeps) {
  return defineSliceManifest({
    basePath: '/public',
    routes: new Hono<AppEnv>().get('/stats', routeClass('public'), async (c) => {
      const result = await buildPublicStats({ stores: deps.stores, db: c.var.db });
      return result.match(
        (stats) => c.json(stats, 200),
        () => c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503)
      );
    }),
  });
}
