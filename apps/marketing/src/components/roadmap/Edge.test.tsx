import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Edge } from './Edge';
import type { RoadmapEdge, RoadmapLayout } from '@hushbox/shared';

const positions: RoadmapLayout['positions'] = {
  '000000000001': { x: 100, y: 100, r: 10 },
  '000000000002': { x: 200, y: 200, r: 10 },
};

function renderInSvg(edge: RoadmapEdge): SVGPathElement | null {
  const { container } = render(
    <svg>
      <Edge edge={edge} positions={positions} />
    </svg>
  );
  return container.querySelector('path');
}

describe('Edge', () => {
  it('renders a path element for a hierarchy edge', () => {
    const path = renderInSvg({
      source: '000000000001',
      target: '000000000002',
      kind: 'hierarchy',
    });
    expect(path).not.toBeNull();
    expect(path?.getAttribute('data-edge-kind')).toBe('hierarchy');
  });

  it('renders dashed stroke for dependency edges', () => {
    const path = renderInSvg({
      source: '000000000001',
      target: '000000000002',
      kind: 'dependency',
    });
    expect(path?.getAttribute('class')).toContain('dasharray');
  });

  it('returns null when source position is missing', () => {
    const { container } = render(
      <svg>
        <Edge
          edge={{ source: 'missing00001', target: '000000000002', kind: 'hierarchy' }}
          positions={positions}
        />
      </svg>
    );
    expect(container.querySelector('path')).toBeNull();
  });

  it('returns null when target position is missing', () => {
    const { container } = render(
      <svg>
        <Edge
          edge={{ source: '000000000001', target: 'missing00002', kind: 'hierarchy' }}
          positions={positions}
        />
      </svg>
    );
    expect(container.querySelector('path')).toBeNull();
  });

  it('hides edges from screen readers via aria-hidden', () => {
    const path = renderInSvg({
      source: '000000000001',
      target: '000000000002',
      kind: 'hierarchy',
    });
    expect(path?.getAttribute('aria-hidden')).toBe('true');
  });
});
