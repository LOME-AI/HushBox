import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SvgColorblindDefs } from './svg-colorblind-defs';
import { COLORBLIND_MATRICES } from './colorblind-matrices';

describe('SvgColorblindDefs', () => {
  it('renders a single root <svg> element', () => {
    const { container } = render(<SvgColorblindDefs />);
    const svgElements = container.querySelectorAll('svg');
    expect(svgElements).toHaveLength(1);
  });

  it('marks the SVG as decorative for assistive tech', () => {
    const { container } = render(<SvgColorblindDefs />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the SVG out-of-flow with zero dimensions and no pointer events', () => {
    const { container } = render(<SvgColorblindDefs />);
    const svg = container.querySelector('svg');
    expect(svg?.style.position).toBe('absolute');
    expect(svg?.style.width).toBe('0px');
    expect(svg?.style.height).toBe('0px');
    expect(svg?.style.pointerEvents).toBe('none');
  });

  it('exposes all five colorblind filter ids', () => {
    const { container } = render(<SvgColorblindDefs />);
    const expectedIds = [
      'a11y-cb-protan',
      'a11y-cb-deutan',
      'a11y-cb-tritan',
      'a11y-cb-achroma',
      'a11y-cb-achromatomaly',
    ];
    for (const id of expectedIds) {
      expect(container.querySelector(`filter#${id}`)).not.toBeNull();
    }
  });

  it('each filter contains a single feColorMatrix child with the corresponding matrix values', () => {
    const { container } = render(<SvgColorblindDefs />);
    for (const [key, expectedValues] of Object.entries(COLORBLIND_MATRICES)) {
      const filter = container.querySelector(`filter#a11y-cb-${key}`);
      expect(filter).not.toBeNull();
      const matrices = filter?.querySelectorAll('feColorMatrix');
      expect(matrices).toBeDefined();
      expect(matrices?.length).toBe(1);
      const matrix = matrices?.item(0);
      expect(matrix).not.toBeNull();
      expect(matrix?.getAttribute('values')).toBe(expectedValues);
    }
  });

  it('places filters inside a <defs> element', () => {
    const { container } = render(<SvgColorblindDefs />);
    const defs = container.querySelector('svg > defs');
    expect(defs).not.toBeNull();
    expect(defs?.querySelectorAll('filter').length).toBe(Object.keys(COLORBLIND_MATRICES).length);
  });
});
