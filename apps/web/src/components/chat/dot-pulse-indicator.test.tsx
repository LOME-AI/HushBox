import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DotPulseIndicator } from './dot-pulse-indicator';

describe('DotPulseIndicator', () => {
  it('renders three animated dots', () => {
    const { container } = render(<DotPulseIndicator />);
    const dots = container.querySelectorAll('.animate-dot-pulse');
    expect(dots).toHaveLength(3);
  });

  it('wraps dots in a container with aria-hidden="true"', () => {
    const { container } = render(<DotPulseIndicator />);
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
  });

  it('applies staggered animation delays of 0s, 0.16s, and 0.32s', () => {
    const { container } = render(<DotPulseIndicator />);
    const dots = container.querySelectorAll('.animate-dot-pulse');
    expect(dots[0]).toHaveStyle({ animationDelay: '0s' });
    expect(dots[1]).toHaveStyle({ animationDelay: '0.16s' });
    expect(dots[2]).toHaveStyle({ animationDelay: '0.32s' });
  });

  it('renders each dot as a small rounded circle', () => {
    const { container } = render(<DotPulseIndicator />);
    const dots = container.querySelectorAll('.animate-dot-pulse');
    for (const dot of dots) {
      expect(dot).toHaveClass('h-1', 'w-1', 'rounded-full', 'bg-current');
    }
  });

  it('uses inline-flex layout with gap for even spacing', () => {
    const { container } = render(<DotPulseIndicator />);
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass('inline-flex', 'items-center', 'gap-0.5');
  });
});
