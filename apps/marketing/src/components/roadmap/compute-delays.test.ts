import { describe, it, expect } from 'vitest';
import { computeAnimationTiming, edgeKeyFor, WAVE_DURATION_S } from './compute-delays';
import type { RoadmapResponse } from '@hushbox/shared';

const ID_P = '000000000001';
const ID_T = '000000000002';
const ID_S = '000000000003';

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
          color: '#000000',
        },
        {
          id: ID_T,
          kind: 'task',
          parentId: ID_P,
          title: 'T',
          status: 'in_progress',
          type: 'feature',
          color: null,
        },
        {
          id: ID_S,
          kind: 'subtask',
          parentId: ID_T,
          title: 'S',
          status: 'in_progress',
          type: 'feature',
          color: null,
        },
      ],
      edges: [
        { source: ID_P, target: ID_T, kind: 'hierarchy' },
        { source: ID_T, target: ID_S, kind: 'hierarchy' },
        { source: ID_S, target: ID_P, kind: 'dependency' },
      ],
    },
    layouts: {
      wide: {
        viewBox: [0, 0, 100, 100],
        positions: {
          [ID_P]: { x: 50, y: 25, r: 10 },
          [ID_T]: { x: 50, y: 50, r: 8 },
          [ID_S]: { x: 50, y: 75, r: 6 },
        },
        bfsOrder: [[ID_P], [ID_T], [ID_S]],
      },
    },
  };
}

describe('computeAnimationTiming', () => {
  it('puts projects (wave 0) at delay 0', () => {
    const timing = computeAnimationTiming(makeData());
    expect(timing.nodeDelays[ID_P]).toBe(0);
  });

  it('delays each subsequent BFS wave by WAVE_DURATION_S', () => {
    const timing = computeAnimationTiming(makeData());
    expect(timing.nodeDelays[ID_T]).toBe(WAVE_DURATION_S);
    expect(timing.nodeDelays[ID_S]).toBe(WAVE_DURATION_S * 2);
  });

  it('dependency edges get a long delay so the tree reveals first', () => {
    const timing = computeAnimationTiming(makeData());
    const key = edgeKeyFor(ID_S, ID_P, 'dependency');
    expect(timing.edgeDelays[key]).toBeGreaterThan(timing.nodeDelays[ID_S] ?? 0);
  });

  it('hierarchy edges schedule before their target node pops', () => {
    const timing = computeAnimationTiming(makeData());
    const edgeKey = edgeKeyFor(ID_P, ID_T, 'hierarchy');
    const edgeDelay = timing.edgeDelays[edgeKey] ?? 0;
    const targetDelay = timing.nodeDelays[ID_T] ?? 0;
    expect(edgeDelay).toBeLessThanOrEqual(targetDelay);
  });

  it('falls back to delay 0 for nodes missing from bfsOrder', () => {
    const data = makeData();
    if (data.layouts.wide !== undefined) data.layouts.wide.bfsOrder = [[ID_P]];
    const timing = computeAnimationTiming(data);
    expect(timing.nodeDelays[ID_T]).toBe(0);
    expect(timing.nodeDelays[ID_S]).toBe(0);
  });

  it('returns a non-zero totalDuration for non-trivial graphs', () => {
    const timing = computeAnimationTiming(makeData());
    expect(timing.totalDuration).toBeGreaterThan(0);
  });
});
