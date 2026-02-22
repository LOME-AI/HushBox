import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CipherWall } from './cipher-wall';

vi.mock('@/hooks/use-cipher-wall', () => ({
  useCipherWall: () => ({ current: null }),
}));

describe('CipherWall', () => {
  it('renders a canvas element', () => {
    render(<CipherWall />);
    expect(screen.getByTestId('cipher-wall')).toBeInstanceOf(HTMLCanvasElement);
  });

  it('has role="img" for accessibility', () => {
    render(<CipherWall />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('has an aria-label describing the animation', () => {
    render(<CipherWall />);
    const canvas = screen.getByRole('img');
    expect(canvas).toHaveAttribute('aria-label');
    expect(canvas.getAttribute('aria-label')).toMatch(/encrypt/i);
  });

  it('has CSS mask-image fading the left edge', () => {
    render(<CipherWall />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toContain('transparent');
    expect(canvas.style.maskImage).toContain('black');
  });

  it('has full-size classes', () => {
    render(<CipherWall />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas).toHaveClass('h-full', 'w-full');
  });
});
