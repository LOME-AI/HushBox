import { Hono } from 'hono';
import { ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { buildRoadmap, createErrorResponse } from './domain/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { LinearClientEnv, LinearClientFactory } from './domain/index.js';

/** The request's bindings widened with this slice's own per-consumer binding. */
type RoadmapBindings = AppEnv['Bindings'] & LinearClientEnv;

interface RoadmapRouteDeps {
  /** Env-mode dispatch; the route holds the bindings, so the factory is bound. */
  readonly linear: LinearClientFactory;
  readonly teamKey: string;
}

/**
 * Public read-only roadmap endpoint (no authentication):
 *
 * - per-IP rate-limited (30 / 60 s) via the edge window enforcer;
 * - any failure surfaces as 503 `SERVICE_UNAVAILABLE`.
 */
export function createRoadmapManifest(deps: RoadmapRouteDeps) {
  return defineSliceManifest({
    basePath: '/public',
    routes: new Hono<AppEnv>().get('/roadmap', routeClass('public'), async (c) => {
      const env: RoadmapBindings = c.env;
      const result = await buildRoadmap({
        linear: deps.linear(env, c.var.envUtils),
        teamKey: deps.teamKey,
      });
      return result.match(
        (response) => c.json(response, 200),
        () => c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503)
      );
    }),
  });
}
