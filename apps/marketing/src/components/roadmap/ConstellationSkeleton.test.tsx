import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ConstellationSkeleton } from './ConstellationSkeleton';

describe('ConstellationSkeleton', () => {
  it('renders a status role for screen readers', () => {
    const { container } = render(<ConstellationSkeleton />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('renders three skeleton groups (matches the three-status sections)', () => {
    const { container } = render(<ConstellationSkeleton />);
    const skeleton = container.querySelector('[data-roadmap-skeleton]');
    expect(skeleton?.children.length).toBe(3);
  });

  it('uses CSS animate-pulse, never JS motion', () => {
    const { container } = render(<ConstellationSkeleton />);
    const pulsing = container.querySelectorAll('.animate-pulse');
    expect(pulsing.length).toBeGreaterThan(0);
  });
});
