import { roadmapResponseSchema } from '@hushbox/shared';
import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { normalizeRoadmap } from './normalize.js';
import type { RoadmapResponse } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { LinearClient } from '../ports/index.js';

interface BuildRoadmapDeps {
  readonly linear: LinearClient;
  readonly teamKey: string;
}

/**
 * The public roadmap board: fetched from Linear, normalized, and validated
 * against the public shape before it is served.
 *
 * Every failure — Linear unreachable, a Linear schema mismatch — surfaces as
 * an error the route maps to a 503.
 */
export function buildRoadmap(deps: BuildRoadmapDeps): ResultAsync<RoadmapResponse, DomainError> {
  return fromPromise(fetchAndNormalize(deps.linear, deps.teamKey), (cause) =>
    unavailableError('roadmap: Linear fetch or normalize failed', cause)
  ).andThen((response) => {
    const parsed = roadmapResponseSchema.safeParse(response);
    if (!parsed.success) {
      return errAsync(
        validationError('roadmap: normalized response failed the public schema', parsed.error)
      );
    }
    return okAsync(parsed.data);
  });
}

async function fetchAndNormalize(linear: LinearClient, teamKey: string): Promise<RoadmapResponse> {
  const data = await linear.fetchRoadmap(teamKey);
  const graph = await normalizeRoadmap(data);
  return { nodes: [...graph.nodes] };
}
