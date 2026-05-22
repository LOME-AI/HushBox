import { describe, it, expect } from 'vitest';
import { computeVisible } from './compute-visible';
import type { RoadmapResponse } from '@hushbox/shared';

const ID_P = '000000000001';
const ID_T1 = '000000000002';
const ID_T2 = '000000000003';

function makeData(): RoadmapResponse {
  return {
    graph: {
      nodes: [
        {
          id: ID_P,
          kind: 'project',
          parentId: null,
          title: 'P',
          status: 'in_progress',
          type: null,
          color: '#ec4755',
        },
        {
          id: ID_T1,
          kind: 'task',
          parentId: ID_P,
          title: 'T1',
          status: 'in_progress',
          type: 'feature',
          color: null,
        },
        {
          id: ID_T2,
          kind: 'task',
          parentId: ID_P,
          title: 'T2',
          status: 'shipped',
          type: 'bug',
          color: null,
        },
      ],
      edges: [],
    },
    layouts: {},
  };
}

const STATUSES_ALL = new Set(['in_progress', 'planned', 'shipped'] as const);
const TYPES_ALL = new Set(['feature', 'bug'] as const);

describe('computeVisible', () => {
  it('includes everything when all filters are on', () => {
    const visible = computeVisible(makeData(), STATUSES_ALL, TYPES_ALL);
    expect(visible.size).toBe(3);
  });

  it('hides issues whose status is filtered out', () => {
    const visible = computeVisible(makeData(), new Set(['in_progress']), TYPES_ALL);
    expect(visible.has(ID_T1)).toBe(true);
    expect(visible.has(ID_T2)).toBe(false);
  });

  it('hides issues whose type is filtered out', () => {
    const visible = computeVisible(makeData(), STATUSES_ALL, new Set(['feature']));
    expect(visible.has(ID_T1)).toBe(true);
    expect(visible.has(ID_T2)).toBe(false);
  });

  it('still shows the project when any descendant survives the filter', () => {
    const visible = computeVisible(makeData(), new Set(['in_progress']), TYPES_ALL);
    expect(visible.has(ID_P)).toBe(true);
  });

  it('hides the project when no descendant survives', () => {
    const visible = computeVisible(makeData(), new Set(['planned']), TYPES_ALL);
    expect(visible.has(ID_P)).toBe(false);
    expect(visible.has(ID_T1)).toBe(false);
    expect(visible.has(ID_T2)).toBe(false);
  });

  it('still shows projects when a subtask survives even if its parent task does not', () => {
    const data = makeData();
    data.graph.nodes.push({
      id: '0000000000aa',
      kind: 'subtask',
      parentId: ID_T2,
      title: 'sub',
      status: 'in_progress',
      type: 'feature',
      color: null,
    });
    const visible = computeVisible(data, new Set(['in_progress']), new Set(['feature']));
    expect(visible.has('0000000000aa')).toBe(true);
    expect(visible.has(ID_T2)).toBe(false);
    expect(visible.has(ID_P)).toBe(true);
  });
});
