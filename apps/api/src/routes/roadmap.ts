import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  ERROR_CODE_SERVICE_UNAVAILABLE,
  roadmapQuerySchema,
  type RoadmapResponse,
} from '@hushbox/shared';
import { rateLimitByIp } from '../middleware/rate-limit.js';
import { createErrorResponse } from '../lib/error-response.js';
import { getLinearClient } from '../services/linear/index.js';
import { RoadmapCache } from '../services/roadmap/cache.js';
import { buildRoadmap } from '../services/roadmap/pipeline.js';
import type { AppEnv } from '../types.js';

const TEAM_KEY = 'HUS';
const CDN_MAX_AGE_SECONDS = 300;

function trimLayouts(
  response: RoadmapResponse,
  layout: 'wide' | 'narrow' | 'both'
): RoadmapResponse {
  if (layout === 'both') return response;
  if (layout === 'wide') {
    return { graph: response.graph, layouts: { wide: response.layouts.wide } };
  }
  return { graph: response.graph, layouts: { narrow: response.layouts.narrow } };
}

/**
 * Public read-only roadmap endpoint. No authentication.
 *
 * - Per-IP rate-limited (30 / 60 s) via {@link rateLimitByIp}
 * - Cached at the Cloudflare edge for 5 min via `Cache-Control: s-maxage=300`
 * - Cached in Upstash Redis for 1 h via {@link RoadmapCache}
 * - Linear failures surface as 503 with code `SERVICE_UNAVAILABLE`; no stale
 *   fallback by design ("if it's down, it doesn't work")
 */
export const roadmapRoute = new Hono<AppEnv>().get(
  '/',
  rateLimitByIp('roadmapIpRateLimit'),
  zValidator('query', roadmapQuerySchema),
  async (c) => {
    const { layout } = c.req.valid('query');
    const redis = c.get('redis');
    const cache = new RoadmapCache(redis, TEAM_KEY);
    const linear = getLinearClient(c.env);

    try {
      const full = await buildRoadmap(linear, cache);
      const trimmed = trimLayouts(full, layout);
      c.header('Cache-Control', `public, s-maxage=${String(CDN_MAX_AGE_SECONDS)}`);
      return c.json(trimmed, 200);
    } catch {
      return c.json(createErrorResponse(ERROR_CODE_SERVICE_UNAVAILABLE), 503);
    }
  }
);
