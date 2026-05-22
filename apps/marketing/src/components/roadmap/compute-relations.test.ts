import { describe, it, expect } from 'vitest';
import { computeRelatedSet } from './compute-relations';
import type { RoadmapResponse } from '@hushbox/shared';

const P = '000000000001';
const T1 = '000000000002';
const T2 = '000000000003';
const S = '000000000004';
const T3 = '000000000005';

function makeData(): RoadmapResponse {
  return {
    graph: {
      nodes: [
        {
          id: P,
          kind: 'project',
          parentId: null,
          title: 'P',
          status: 'in_progress',
          type: null,
          color: '#000000',
        },
        {
          id: T1,
          kind: 'task',
          parentId: P,
          title: 'T1',
          status: 'in_progress',
          type: 'feature',
          color: null,
        },
        {
          id: T2,
          kind: 'task',
          parentId: P,
          title: 'T2',
          status: 'in_progress',
          type: 'feature',
          color: null,
        },
        {
          id: S,
          kind: 'subtask',
          parentId: T1,
          title: 'S',
          status: 'in_progress',
          type: 'feature',
          color: null,
        },
        {
          id: T3,
          kind: 'task',
          parentId: null,
          title: 'T3',
          status: 'planned',
          type: 'feature',
          color: null,
        },
      ],
      edges: [
        { source: P, target: T1, kind: 'hierarchy' },
        { source: P, target: T2, kind: 'hierarchy' },
        { source: T1, target: S, kind: 'hierarchy' },
        { source: T1, target: T3, kind: 'dependency' },
      ],
    },
    layouts: {},
  };
}

describe('computeRelatedSet', () => {
  it('includes the focused node itself', () => {
    const related = computeRelatedSet(makeData(), T1);
    expect(related.has(T1)).toBe(true);
  });

  it('includes the project ancestor of a task', () => {
    const related = computeRelatedSet(makeData(), T1);
    expect(related.has(P)).toBe(true);
  });

  it('includes a subtask under the focused task', () => {
    const related = computeRelatedSet(makeData(), T1);
    expect(related.has(S)).toBe(true);
  });

  it('walks up from a subtask all the way to the project', () => {
    const related = computeRelatedSet(makeData(), S);
    expect(related.has(T1)).toBe(true);
    expect(related.has(P)).toBe(true);
  });

  it('includes the dependency target', () => {
    const related = computeRelatedSet(makeData(), T1);
    expect(related.has(T3)).toBe(true);
  });

  it('includes the dependency source (reverse direction)', () => {
    const related = computeRelatedSet(makeData(), T3);
    expect(related.has(T1)).toBe(true);
  });

  it('excludes siblings that are not directly related', () => {
    const related = computeRelatedSet(makeData(), T1);
    expect(related.has(T2)).toBe(false);
  });

  it('handles unknown focused ids gracefully (returns just that id)', () => {
    const related = computeRelatedSet(makeData(), 'unknown00000');
    expect(related.size).toBe(1);
    expect(related.has('unknown00000')).toBe(true);
  });
});
