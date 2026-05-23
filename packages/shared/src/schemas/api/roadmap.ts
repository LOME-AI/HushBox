import { z } from 'zod';

/**
 * Public roadmap response schema. The marketing site's /roadmap page fetches
 * this JSON from the API and renders a status-grouped board. The schema is
 * the second wall (after the Linear GraphQL select list) that prevents
 * internal Linear data from leaking onto the public surface — opaque ids
 * only, no descriptions, assignees, urls, timestamps, or priority.
 */

const nodeKindSchema = z.enum(['project', 'task', 'subtask']);
const statusSchema = z.enum(['in_progress', 'planned', 'shipped']);
const issueTypeSchema = z.enum(['feature', 'bug']);

/**
 * 12-hex-char SHA-256 prefix used as an opaque identifier on the wire.
 * Server replaces every raw Linear id with this shape so the marketing
 * API contract never exposes Linear's identifier scheme.
 */
export const opaqueRoadmapIdSchema = z
  .string()
  .length(12)
  .regex(/^[0-9a-f]{12}$/, 'must be a 12-character lowercase hex string');

/**
 * Derived progress for a project node. `done` and `total` count direct
 * children (tasks) only — not subtasks, which roll up into their parent
 * task's status. Server-side derivation keeps the math next to the
 * status roll-up in normalize.ts.
 */
const progressSchema = z.object({
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});

export const roadmapNodeSchema = z.object({
  id: opaqueRoadmapIdSchema,
  kind: nodeKindSchema,
  parentId: opaqueRoadmapIdSchema.nullable(),
  title: z.string().min(1).max(200),
  status: statusSchema,
  /** null for project nodes (which don't carry a type label). */
  type: issueTypeSchema.nullable(),
  /** Present only on project nodes. */
  progress: progressSchema.optional(),
});

export type RoadmapNode = z.infer<typeof roadmapNodeSchema>;

export const roadmapResponseSchema = z.object({
  nodes: z.array(roadmapNodeSchema).max(500),
});

export type RoadmapResponse = z.infer<typeof roadmapResponseSchema>;
