import { z } from 'zod';

/**
 * Public roadmap response schema. The marketing site's /roadmap page fetches
 * this JSON from the API and renders a constellation. The schema is the
 * second wall (after the Linear GraphQL select list) that prevents internal
 * Linear data from leaking onto the public surface — opaque ids only, no
 * descriptions, assignees, urls, timestamps, or priority.
 */

const nodeKindSchema = z.enum(['project', 'task', 'subtask']);
const statusSchema = z.enum(['in_progress', 'planned', 'shipped']);
const issueTypeSchema = z.enum(['feature', 'bug']);
const edgeKindSchema = z.enum(['hierarchy', 'dependency']);

/**
 * 12-hex-char SHA-256 prefix used as an opaque identifier on the wire.
 * Server replaces every raw Linear id with this shape so the marketing
 * API contract never exposes Linear's identifier scheme.
 */
export const opaqueRoadmapIdSchema = z
  .string()
  .length(12)
  .regex(/^[0-9a-f]{12}$/, 'must be a 12-character lowercase hex string');

const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color')
  .nullable();

export const roadmapNodeSchema = z.object({
  id: opaqueRoadmapIdSchema,
  kind: nodeKindSchema,
  parentId: opaqueRoadmapIdSchema.nullable(),
  title: z.string().min(1).max(200),
  status: statusSchema,
  /** null for project nodes (which don't carry a type label). */
  type: issueTypeSchema.nullable(),
  /** Hex color shown by the marketing renderer. Only populated for projects today. */
  color: colorSchema,
});

export type RoadmapNode = z.infer<typeof roadmapNodeSchema>;

export const roadmapEdgeSchema = z.object({
  source: opaqueRoadmapIdSchema,
  target: opaqueRoadmapIdSchema,
  kind: edgeKindSchema,
});

export type RoadmapEdge = z.infer<typeof roadmapEdgeSchema>;

const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
  r: z.number().positive().max(100),
});

export const roadmapLayoutSchema = z.object({
  viewBox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Keyed by node id; one entry per visible node. */
  positions: z.record(opaqueRoadmapIdSchema, positionSchema),
  /**
   * Reveal ordering for the load animation. Each inner array is one wave of
   * sibling nodes that should animate in together; outer order is depth from
   * the project roots outward. The client iterates these waves to play
   * Lightning Fuse.
   */
  bfsOrder: z.array(z.array(opaqueRoadmapIdSchema)),
});

export type RoadmapLayout = z.infer<typeof roadmapLayoutSchema>;

export const roadmapResponseSchema = z.object({
  graph: z.object({
    nodes: z.array(roadmapNodeSchema).max(500),
    edges: z.array(roadmapEdgeSchema).max(1000),
  }),
  layouts: z.object({
    wide: roadmapLayoutSchema.optional(),
    narrow: roadmapLayoutSchema.optional(),
  }),
});

export type RoadmapResponse = z.infer<typeof roadmapResponseSchema>;

/**
 * Query schema for GET /api/roadmap?layout=...
 * Default returns both layouts; the marketing client picks one based on viewport.
 */
export const roadmapQuerySchema = z.object({
  layout: z.enum(['wide', 'narrow', 'both']).optional().default('both'),
});

export type RoadmapQuery = z.infer<typeof roadmapQuerySchema>;
