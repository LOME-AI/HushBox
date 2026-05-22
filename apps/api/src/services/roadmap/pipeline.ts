import { roadmapResponseSchema, type RoadmapResponse } from '@hushbox/shared';
import type { LinearClient } from '../linear/index.js';
import { normalizeRoadmap } from './normalize.js';
import { computeWideLayout, computeNarrowLayout } from './layout.js';
import type { RoadmapCache } from './cache.js';

const TEAM_KEY = 'HUS';

/**
 * Orchestrate the full roadmap pipeline. On cache miss this fetches
 * Linear, normalizes the data into our opaque graph, computes both
 * wide and narrow layouts, validates the response shape, and writes
 * it to Redis. On cache hit it returns the cached value untouched.
 *
 * Throws on Linear failures — the caller maps thrown errors to a 503.
 */
export async function buildRoadmap(
  linear: LinearClient,
  cache: RoadmapCache
): Promise<RoadmapResponse> {
  const cached = await cache.get();
  if (cached !== null) return cached;

  const linearData = await linear.fetchRoadmap(TEAM_KEY);
  const graph = await normalizeRoadmap(linearData);
  const wide = computeWideLayout(graph);
  const narrow = computeNarrowLayout(graph);

  const response: RoadmapResponse = roadmapResponseSchema.parse({
    graph: { nodes: graph.nodes, edges: graph.edges },
    layouts: { wide, narrow },
  });

  await cache.set(response);
  return response;
}
