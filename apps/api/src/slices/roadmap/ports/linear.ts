/**
 * Internal Linear client types. These are the shape returned by both the
 * real GraphQL client and the mock client. Downstream code (normalize, the
 * roadmap build) consumes this type and never sees raw GraphQL responses.
 *
 * Sensitive Linear fields (description, assignee, creator, comments, customer
 * data, urls, dueDate, estimate, priority, identifier) are NEVER included
 * here. The narrow type IS the first wall against accidental leaks; the
 * public `roadmapResponseSchema` in `@hushbox/shared` is the second.
 */

import type { EnvUtilities } from '@hushbox/shared';

export interface LinearClient {
  /**
   * Fetch all visible roadmap data for a team. Returns the project list
   * and the issue list separately because the real GraphQL API exposes
   * them as separate queries; downstream code joins them.
   */
  fetchRoadmap(teamKey: string): Promise<LinearRoadmapData>;
}

/**
 * `LINEAR_API_KEY_READ` is this slice's own per-consumer binding rather than
 * one of the app-wide `AppEnv` bindings: the env registry declares it for
 * CiVitest and Production only, so the type keeps it optional and the factory
 * fails fast when a mode that needs it has none.
 */
export interface LinearClientEnv {
  LINEAR_API_KEY_READ?: string;
}

/**
 * Env-mode dispatch to a client implementation. The route holds the request's
 * bindings and env utilities, so the composition root binds the factory rather
 * than a client and the route calls it per request.
 */
export type LinearClientFactory = (
  env: LinearClientEnv,
  envUtilities: EnvUtilities
) => LinearClient;

export interface LinearRoadmapData {
  projects: readonly LinearProject[];
  issues: readonly LinearIssue[];
}

export type LinearProjectStateType = 'started' | 'planned' | 'completed' | 'paused' | 'backlog';

export interface LinearProject {
  id: string;
  name: string;
  color: string;
  stateType: LinearProjectStateType;
}

export type LinearIssueStateType = 'unstarted' | 'started' | 'completed' | 'backlog';

export interface LinearIssue {
  id: string;
  title: string;
  stateName: string;
  stateType: LinearIssueStateType;
  labelNames: readonly string[];
  parentId: string | null;
  projectId: string | null;
  relations: readonly LinearRelation[];
}

type LinearRelationKind = 'blocks' | 'blocked_by';

export interface LinearRelation {
  type: LinearRelationKind;
  relatedIssueId: string;
}
