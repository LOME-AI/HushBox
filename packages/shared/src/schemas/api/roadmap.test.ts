import { describe, it, expect } from 'vitest';
import { roadmapResponseSchema, roadmapNodeSchema, opaqueRoadmapIdSchema } from './roadmap.js';

const validId = '0123456789ab';
const otherId = 'fedcba987654';

const validProject = {
  id: validId,
  kind: 'project' as const,
  parentId: null,
  title: 'Custom system prompts',
  status: 'in_progress' as const,
  type: null,
  progress: { done: 1, total: 4 },
};

const validTask = {
  id: otherId,
  kind: 'task' as const,
  parentId: validId,
  title: 'Save and reuse prompt presets',
  status: 'in_progress' as const,
  type: 'feature' as const,
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
  it('parses a valid project node with progress', () => {
    expect(roadmapNodeSchema.parse(validProject)).toEqual(validProject);
  });

  it('parses a task node without a progress field', () => {
    expect(roadmapNodeSchema.parse(validTask)).toEqual(validTask);
  });

  it('parses a subtask with a task parent', () => {
    const subtask = { ...validTask, kind: 'subtask' as const, title: 'Apply preset' };
    expect(roadmapNodeSchema.parse(subtask)).toEqual(subtask);
  });

  it('rejects unknown kinds', () => {
    expect(roadmapNodeSchema.safeParse({ ...validProject, kind: 'epic' }).success).toBe(false);
  });

  it('rejects unknown statuses', () => {
    expect(roadmapNodeSchema.safeParse({ ...validProject, status: 'cancelled' }).success).toBe(
      false
    );
  });

  it('rejects empty titles', () => {
    expect(roadmapNodeSchema.safeParse({ ...validProject, title: '' }).success).toBe(false);
  });

  it('rejects titles over 200 characters', () => {
    expect(roadmapNodeSchema.safeParse({ ...validProject, title: 'x'.repeat(201) }).success).toBe(
      false
    );
  });

  it('drops unknown fields so internal data cannot leak', () => {
    const parsed = roadmapNodeSchema.parse({
      ...validProject,
      description: 'this should never leak',
    });
    expect(parsed).not.toHaveProperty('description');
  });

  it('rejects progress with negative done', () => {
    expect(
      roadmapNodeSchema.safeParse({ ...validProject, progress: { done: -1, total: 4 } }).success
    ).toBe(false);
  });

  it('rejects progress with negative total', () => {
    expect(
      roadmapNodeSchema.safeParse({ ...validProject, progress: { done: 0, total: -1 } }).success
    ).toBe(false);
  });

  it('rejects progress with non-integer values', () => {
    expect(
      roadmapNodeSchema.safeParse({ ...validProject, progress: { done: 1.5, total: 4 } }).success
    ).toBe(false);
  });

  it('accepts a zero-total progress (project with no tasks)', () => {
    const empty = { ...validProject, progress: { done: 0, total: 0 } };
    expect(roadmapNodeSchema.parse(empty)).toEqual(empty);
  });
});

describe('roadmapResponseSchema', () => {
  it('parses a response containing only a nodes array', () => {
    const response = { nodes: [validProject, validTask] };
    expect(roadmapResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects more than 500 nodes', () => {
    const nodes = Array.from({ length: 501 }, (_, index) => ({
      ...validTask,
      id: index.toString(16).padStart(12, '0'),
    }));
    expect(roadmapResponseSchema.safeParse({ nodes }).success).toBe(false);
  });

  it('rejects a response with an edges field (edges are no longer part of the contract)', () => {
    const response = { nodes: [validProject], edges: [] };
    const parsed = roadmapResponseSchema.parse(response);
    expect(parsed).not.toHaveProperty('edges');
  });

  it('rejects a response with a layouts field (layouts are no longer part of the contract)', () => {
    const response = { nodes: [validProject], layouts: {} };
    const parsed = roadmapResponseSchema.parse(response);
    expect(parsed).not.toHaveProperty('layouts');
  });
});
