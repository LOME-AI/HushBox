import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './icon';
import { HelcimMark } from './helcim-mark';

describe('HelcimMark', () => {
  it('draws the "Powered by Helcim" wordmark at its own 148 by 20 size when unsized', () => {
    const { container } = render(<HelcimMark />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 148 20');
    expect(svg).toHaveAttribute('width', '148');
    expect(svg).toHaveAttribute('height', '20');
  });

  it("keeps the vendor's accent dot colour", () => {
    const { container } = render(<HelcimMark />);

    expect(container.querySelector('path[fill="#815AF0"]')).not.toBeNull();
  });

  it('takes a class and ARIA from Icon', () => {
    const { container } = render(<Icon icon={HelcimMark} className="text-foreground" />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('size-4', 'text-foreground');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });
});
