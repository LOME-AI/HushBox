/**
 * Internal types for the roadmap pipeline. The public response shape lives
 * in `@hushbox/shared` (RoadmapResponseSchema); these types are the
 * in-flight representation used while building it.
 */

import type { RoadmapEdge, RoadmapNode, RoadmapResponse } from '@hushbox/shared';

export type NormalizedNode = RoadmapNode;
export type NormalizedEdge = RoadmapEdge;

export interface NormalizedGraph {
  nodes: readonly NormalizedNode[];
  edges: readonly NormalizedEdge[];
}

export interface LayoutResult {
  viewBox: [number, number, number, number];
  positions: Record<string, { x: number; y: number; r: number }>;
  bfsOrder: string[][];
}

export type RoadmapPipelineResponse = RoadmapResponse;
