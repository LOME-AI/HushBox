import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './icon';
import { GitHubMark } from './github-mark';

describe('GitHubMark', () => {
  it('fills the mark in the current colour on a 16-unit box', () => {
    const { container } = render(<GitHubMark />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 16 16');
    expect(svg).toHaveAttribute('fill', 'currentColor');
  });

  it('draws the mark as one path', () => {
    const { container } = render(<GitHubMark />);

    expect(container.querySelectorAll('path')).toHaveLength(1);
  });

  it('takes its size and ARIA from Icon', () => {
    const { container } = render(<Icon icon={GitHubMark} />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('size-4');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });
});
