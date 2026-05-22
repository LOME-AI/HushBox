import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Constellation } from './Constellation';
import type { RoadmapResponse } from '@hushbox/shared';

const ID_P = '0000000000aa';
const ID_T1 = '0000000000bb';
const ID_T2 = '0000000000cc';

const positions = {
  [ID_P]: { x: 200, y: 200, r: 24 },
  [ID_T1]: { x: 100, y: 300, r: 14 },
  [ID_T2]: { x: 300, y: 300, r: 14 },
} as const;

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
          status: 'planned',
          type: 'bug',
          color: null,
        },
      ],
      edges: [
        { source: ID_P, target: ID_T1, kind: 'hierarchy' },
        { source: ID_P, target: ID_T2, kind: 'hierarchy' },
        { source: ID_T1, target: ID_T2, kind: 'dependency' },
      ],
    },
    layouts: {
      wide: { viewBox: [0, 0, 400, 400], positions, bfsOrder: [[ID_P], [ID_T1, ID_T2]] },
      narrow: { viewBox: [0, 0, 400, 800], positions, bfsOrder: [[ID_P], [ID_T1, ID_T2]] },
    },
  };
}

describe('Constellation', () => {
  it('renders an SVG with the layout viewBox', () => {
    const { container } = render(<Constellation data={makeData()} layout="wide" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 400 400');
  });

  it('renders one <g> per node', () => {
    const { container } = render(<Constellation data={makeData()} layout="wide" />);
    expect(container.querySelectorAll('[data-node]').length).toBe(3);
  });

  it('renders hierarchy and dependency edges in wide layout', () => {
    const { container } = render(<Constellation data={makeData()} layout="wide" />);
    expect(container.querySelectorAll('[data-edge-kind="hierarchy"]').length).toBe(2);
    expect(container.querySelectorAll('[data-edge-kind="dependency"]').length).toBe(1);
  });

  it('omits dependency edges in narrow layout (replaced by node badges)', () => {
    const { container } = render(<Constellation data={makeData()} layout="narrow" />);
    expect(container.querySelectorAll('[data-edge-kind="dependency"]').length).toBe(0);
    expect(container.querySelectorAll('[data-edge-kind="hierarchy"]').length).toBe(2);
  });

  it('provides a screen-reader fallback list of all nodes', () => {
    const { container } = render(<Constellation data={makeData()} layout="wide" />);
    const list = container.querySelector('ul');
    expect(list?.children.length).toBe(3);
  });

  it('returns null if the requested layout is not in the response', () => {
    const data = makeData();
    data.layouts.narrow = undefined;
    const { container } = render(<Constellation data={data} layout="narrow" />);
    expect(container.firstChild).toBeNull();
  });

  it('uses the layout prop in the data-layout attribute', () => {
    const { container } = render(<Constellation data={makeData()} layout="narrow" />);
    expect(
      container.querySelector('[data-roadmap-constellation]')?.getAttribute('data-layout')
    ).toBe('narrow');
  });
});
