import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './icon';
import { ScrollChevron } from './scroll-chevron';

describe('ScrollChevron', () => {
  it("draws the /welcome hero's scroll arrow path", () => {
    const { container } = render(<ScrollChevron />);

    expect(container.querySelector('path')).toHaveAttribute('d', 'M19 9l-7 7-7-7');
  });

  it('strokes the path with round caps and joins at width 2', () => {
    const { container } = render(<ScrollChevron />);

    const path = container.querySelector('path');
    expect(path).toHaveAttribute('stroke-linecap', 'round');
    expect(path).toHaveAttribute('stroke-linejoin', 'round');
    expect(path).toHaveAttribute('stroke-width', '2');
  });

  it('strokes in the current colour on a 24-unit box with no fill', () => {
    const { container } = render(<ScrollChevron />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
  });

  it('draws at the display size through Icon', () => {
    const { container } = render(<Icon icon={ScrollChevron} size="display" />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('size-16');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });
});
