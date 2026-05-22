import { describe, it, expect } from 'vitest';
import {
  roadmapResponseSchema,
  roadmapNodeSchema,
  roadmapEdgeSchema,
  roadmapLayoutSchema,
  opaqueRoadmapIdSchema,
  roadmapQuerySchema,
} from './roadmap.js';

const validId = '0123456789ab';
const otherId = 'fedcba987654';

const validNode = {
  id: validId,
  kind: 'project' as const,
  parentId: null,
  title: 'Custom system prompts',
  status: 'in_progress' as const,
  type: null,
  color: '#ec4755',
};

const validEdge = {
  source: validId,
  target: otherId,
  kind: 'hierarchy' as const,
};

const validLayout = {
  viewBox: [0, 0, 1600, 900],
  positions: {
    [validId]: { x: 100, y: 200, r: 24 },
    [otherId]: { x: 300, y: 400, r: 14 },
  },
  bfsOrder: [[validId], [otherId]],
};

const validResponse = {
  graph: {
    nodes: [validNode],
    edges: [validEdge],
  },
  layouts: {
    wide: validLayout,
    narrow: validLayout,
  },
};

describe('opaqueRoadmapIdSchema', () => {
  it('accepts a 12-character lowercase hex string', () => {
    expect(opaqueRoadmapIdSchema.parse('0123456789ab')).toBe('0123456789ab');
  });

  it('rejects uppercase hex', () => {
    expect(opaqueRoadmapIdSchema.safeParse('0123456789AB').success).toBe(false);
  });

  it('rejects shorter input', () => {
    expect(opaqueRoadmapIdSchema.safeParse('0123456789a').success).toBe(false);
  });

  it('rejects longer input', () => {
    expect(opaqueRoadmapIdSchema.safeParse('0123456789abc').success).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(opaqueRoadmapIdSchema.safeParse('0123456789ag').success).toBe(false);
  });

  it('rejects raw Linear ids (UUIDs)', () => {
    expect(opaqueRoadmapIdSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(
      false
    );
  });
});

describe('roadmapNodeSchema', () => {
  it('parses a valid project node', () => {
    expect(roadmapNodeSchema.parse(validNode)).toEqual(validNode);
  });

  it('parses a task with a parent and type', () => {
    const task = {
      ...validNode,
      kind: 'task',
      parentId: otherId,
      type: 'feature',
      color: null,
    };
    expect(roadmapNodeSchema.parse(task)).toEqual(task);
  });

  it('rejects unknown kinds', () => {
    expect(roadmapNodeSchema.safeParse({ ...validNode, kind: 'epic' }).success).toBe(false);
  });

  it('rejects unknown statuses', () => {
    expect(roadmapNodeSchema.safeParse({ ...validNode, status: 'cancelled' }).success).toBe(false);
  });

  it('rejects empty titles', () => {
    expect(roadmapNodeSchema.safeParse({ ...validNode, title: '' }).success).toBe(false);
  });

  it('rejects titles over 200 characters', () => {
    expect(roadmapNodeSchema.safeParse({ ...validNode, title: 'x'.repeat(201) }).success).toBe(
      false
    );
  });

  it('rejects unknown fields by default (extra props are dropped, not retained)', () => {
    const parsed = roadmapNodeSchema.parse({
      ...validNode,
      description: 'this should never leak',
    });
    expect(parsed).not.toHaveProperty('description');
  });

  it('rejects 8-digit hex colors', () => {
    expect(roadmapNodeSchema.safeParse({ ...validNode, color: '#ec4755ff' }).success).toBe(false);
  });
});

describe('roadmapEdgeSchema', () => {
  it('parses a hierarchy edge', () => {
    expect(roadmapEdgeSchema.parse(validEdge)).toEqual(validEdge);
  });

  it('parses a dependency edge', () => {
    const dep = { ...validEdge, kind: 'dependency' as const };
    expect(roadmapEdgeSchema.parse(dep)).toEqual(dep);
  });

  it('rejects unknown edge kinds', () => {
    expect(roadmapEdgeSchema.safeParse({ ...validEdge, kind: 'related' }).success).toBe(false);
  });
});

describe('roadmapLayoutSchema', () => {
  it('parses a layout with both wide and narrow viewBoxes', () => {
    expect(roadmapLayoutSchema.parse(validLayout)).toEqual(validLayout);
  });

  it('rejects infinite positions', () => {
    expect(
      roadmapLayoutSchema.safeParse({
        ...validLayout,
        positions: { [validId]: { x: Number.POSITIVE_INFINITY, y: 0, r: 1 } },
      }).success
    ).toBe(false);
  });

  it('rejects non-positive radii', () => {
    expect(
      roadmapLayoutSchema.safeParse({
        ...validLayout,
        positions: { [validId]: { x: 0, y: 0, r: 0 } },
      }).success
    ).toBe(false);
  });

  it('rejects oversize radii (sanity ceiling)', () => {
    expect(
      roadmapLayoutSchema.safeParse({
        ...validLayout,
        positions: { [validId]: { x: 0, y: 0, r: 101 } },
      }).success
    ).toBe(false);
  });
});

describe('roadmapResponseSchema', () => {
  it('parses a complete response', () => {
    expect(roadmapResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('parses a response with one layout missing', () => {
    const wideOnly = { ...validResponse, layouts: { wide: validLayout } };
    expect(roadmapResponseSchema.parse(wideOnly)).toEqual(wideOnly);
  });

  it('rejects more than 500 nodes', () => {
    const nodes = Array.from({ length: 501 }, (_, index) => ({
      ...validNode,
      id: index.toString(16).padStart(12, '0'),
    }));
    expect(
      roadmapResponseSchema.safeParse({
        ...validResponse,
        graph: { ...validResponse.graph, nodes },
      }).success
    ).toBe(false);
  });

  it('rejects more than 1000 edges', () => {
    const edges = Array.from({ length: 1001 }, () => validEdge);
    expect(
      roadmapResponseSchema.safeParse({
        ...validResponse,
        graph: { ...validResponse.graph, edges },
      }).success
    ).toBe(false);
  });
});

describe('roadmapQuerySchema', () => {
  it('defaults to both when no layout param is given', () => {
    expect(roadmapQuerySchema.parse({})).toEqual({ layout: 'both' });
  });

  it.each(['wide', 'narrow', 'both'] as const)('accepts layout=%s', (value) => {
    expect(roadmapQuerySchema.parse({ layout: value })).toEqual({ layout: value });
  });

  it('rejects unknown layout values', () => {
    expect(roadmapQuerySchema.safeParse({ layout: 'gantt' }).success).toBe(false);
  });
});
